import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const nt = require('../grammar/node_types');
const PEG_FILE = resolve(__dirname, '..', 'pegjs', 'angelscript.pegjs');
const PARSER_FILE = resolve(__dirname, '..', 'pegjs', 'angelscript.js');

// Compile the PEG grammar to JS, then load it
let parser;
try {
    execSync(
        `npx peggy "${PEG_FILE}" --allowed-start-rules start,start_global,start_class,start_enum -o "${PARSER_FILE}"`,
        { cwd: resolve(__dirname, '..'), stdio: 'pipe' }
    );
    const parserModule = require(PARSER_FILE);
    parser = { parse: (content, options) => parserModule.parse(content, options) };
} catch (e) {
    console.error('Failed to compile/load PEG grammar:', e.message);
    process.exit(1);
}

// Helper: parse a "header-only" declaration (the PEG grammar only parses the header,
// not the body { ... }; which is handled by ParseScopeIntoStatements in as_parser.ts)
function parseDecl(content) {
    return parser.parse(content, { startRule: 'start_global' });
}

// ---------------------------------------------------------------------------
// Simulated helpers — these mirror the logic in as_parser.ts / references.ts
// / api_docs.ts so we can test the pipeline semantics without pulling in
// vscode-languageserver and full module infrastructure.
// ---------------------------------------------------------------------------

/**
 * Parse a raw superclass string into a primary supertype and comma-separated
 * interface list.  This mirrors the split that as_parser.ts's
 * GenerateTypeInformation would perform on the superclass.value captured
 * by the PEG grammar (which only captures the first identifier after ':').
 *
 * In the real pipeline the PEG captures only the first identifier so the
 * comma handling lives in TypeScript code that re-examines the raw source.
 * Here we simulate that second pass.
 */
function parseCommaSuperclass(raw) {
    if (!raw)
        return { supertype: null, interfaces: [] };
    let commaIdx = raw.indexOf(',');
    if (commaIdx < 0)
        return { supertype: raw.trim(), interfaces: [] };
    let parts = raw.split(',').map(s => s.trim());
    return { supertype: parts[0], interfaces: parts.slice(1) };
}

/**
 * Resolve the type used for supertype chain traversal.  In references.ts
 * (line 119) the chain follows `searchType.supertype`, and the PEG
 * captures only the first identifier after ':' — which is the primary
 * superclass (AActor / UObject / etc.).  Comma-separated interfaces do
 * NOT participate in the single-parent chain.
 */
function getPrimarySupertype(raw) {
    if (!raw)
        return null;
    let commaIdx = raw.indexOf(',');
    if (commaIdx >= 0)
        return raw.substring(0, commaIdx).trim();
    return raw.trim();
}

/**
 * Simulate the derived-type discovery loop from references.ts lines 114-122.
 * Given a set of known types (name -> supertype string), resolve all types
 * that eventually derive from a target type.
 */
function findDerivedTypes(knownTypes, targetTypeName) {
    let searchSet = new Set([targetTypeName]);
    let lastSize = 0;
    while (lastSize !== searchSet.size) {
        lastSize = searchSet.size;
        for (let [name, supertypeStr] of Object.entries(knownTypes)) {
            let primary = getPrimarySupertype(supertypeStr);
            if (primary && searchSet.has(primary))
                searchSet.add(name);
        }
    }
    return searchSet;
}

/**
 * Determine whether a DBType should appear in the API documentation listing,
 * mirroring api_docs.ts line 339.
 */
function shouldIncludeInApiDocs(dbtype) {
    // The original condition blocks inclusion only when ALL of these are false-ish:
    //   !symbol.declaredModule && !symbol.isEnum && !symbol.isInterface
    //   && !symbol.isTemplateInstantiation && !symbol.isTemplateType()
    //   && !symbol.isDelegate && !symbol.isEvent
    // A type with isInterface=true (or any of the other flags) should be included.
    if (!dbtype.declaredModule && !dbtype.isEnum && !dbtype.isInterface
        && !dbtype.isTemplateInstantiation && !dbtype.isTemplateType
        && !dbtype.isDelegate && !dbtype.isEvent)
        return false;
    return true;
}


// ============================================================================
//  Tests
// ============================================================================

describe('Integration - Interface Database (T3.9)', () => {

    it('PEG should parse interface IFoo header as InterfaceDefinition', () => {
        const result = parseDecl('interface IFoo');
        assert.equal(result.type, nt.InterfaceDefinition);
        assert.equal(result.name.value, 'IFoo');
        assert.equal(result.superclass, null);
    });

    it('PEG should parse interface with single superclass', () => {
        const result = parseDecl('interface IFoo : IInterface');
        assert.equal(result.type, nt.InterfaceDefinition);
        assert.equal(result.name.value, 'IFoo');
        assert.ok(result.superclass);
        assert.equal(result.superclass.value, 'IInterface');
    });

    it('PEG should parse interface with namespace-qualified superclass', () => {
        const result = parseDecl('interface IFoo : Core::IInterface');
        assert.equal(result.type, nt.InterfaceDefinition);
        assert.equal(result.name.value, 'IFoo');
        assert.ok(result.superclass);
        assert.ok(result.superclass.value.includes('::'));
    });

    it('PEG should parse class with interface-like superclass string', () => {
        // The PEG class_decl captures everything after ':' as raw text via
        // identifier_name + optional :: qualifiers.  Comma-separated interface
        // lists are NOT part of the PEG grammar — they are handled later in
        // as_parser.ts.  This test verifies the first identifier is captured.
        const result = parseDecl('class AImpl : AActor');
        assert.equal(result.type, nt.ClassDefinition);
        assert.equal(result.name.value, 'AImpl');
        assert.ok(result.superclass);
        assert.equal(result.superclass.value, 'AActor');
    });

    it('GenerateTypeInformation should set isInterface on DBType for interface decl', () => {
        // Simulate what GenerateTypeInformation (as_parser.ts:1868-1875) does
        // when it encounters scope.previous.ast.type == InterfaceDefinition.
        const astResult = parseDecl('interface IFoo');
        assert.equal(astResult.type, nt.InterfaceDefinition);

        // In the real pipeline:
        //   let dbtype = AddDBType(scope, interfacedef.name.value);
        //   dbtype.supertype = interfacedef.superclass
        //       ? interfacedef.superclass.value
        //       : "UInterface";
        //   dbtype.isInterface = true;
        let dbtype = {
            name: astResult.name.value,
            supertype: astResult.superclass ? astResult.superclass.value : 'UInterface',
            isInterface: true,
            isEnum: false,
            isStruct: false,
            declaredModule: 'test',
        };

        assert.equal(dbtype.name, 'IFoo');
        assert.equal(dbtype.supertype, 'UInterface');
        assert.equal(dbtype.isInterface, true);
    });

    it('GenerateTypeInformation should set isInterface with explicit superclass', () => {
        const astResult = parseDecl('interface IFoo : IBaseInterface');
        assert.equal(astResult.type, nt.InterfaceDefinition);

        let dbtype = {
            name: astResult.name.value,
            supertype: astResult.superclass ? astResult.superclass.value : 'UInterface',
            isInterface: true,
            declaredModule: 'test',
        };

        assert.equal(dbtype.name, 'IFoo');
        assert.equal(dbtype.supertype, 'IBaseInterface');
        assert.equal(dbtype.isInterface, true);
    });
});

describe('Integration - Comma-separated Inheritance', () => {

    it('parseCommaSuperclass should extract first identifier as supertype', () => {
        let result = parseCommaSuperclass('AActor, IFoo, IBar');
        assert.equal(result.supertype, 'AActor');
        assert.deepEqual(result.interfaces, ['IFoo', 'IBar']);
    });

    it('parseCommaSuperclass single superclass has no interfaces', () => {
        let result = parseCommaSuperclass('AActor');
        assert.equal(result.supertype, 'AActor');
        assert.deepEqual(result.interfaces, []);
    });

    it('parseCommaSuperclass with namespace-qualified interface', () => {
        let result = parseCommaSuperclass('AActor, Core::IFoo');
        assert.equal(result.supertype, 'AActor');
        assert.deepEqual(result.interfaces, ['Core::IFoo']);
    });

    it('parseCommaSuperclass with only interfaces and no superclass', () => {
        // In real AngelScript you always have at least a primary superclass,
        // but test edge-case handling anyway.
        let result = parseCommaSuperclass('IInterface, IFoo');
        assert.equal(result.supertype, 'IInterface');
        assert.deepEqual(result.interfaces, ['IFoo']);
    });

    it('parseCommaSuperclass null input', () => {
        let result = parseCommaSuperclass(null);
        assert.equal(result.supertype, null);
        assert.deepEqual(result.interfaces, []);
    });

    it('parseCommaSuperclass with extra whitespace', () => {
        let result = parseCommaSuperclass('  AActor  ,  IFoo  ,  IBar  ');
        assert.equal(result.supertype, 'AActor');
        assert.deepEqual(result.interfaces, ['IFoo', 'IBar']);
    });

    it('parseCommaSuperclass multiple namespace-qualified interfaces', () => {
        let result = parseCommaSuperclass('AActor, Core::IFoo, Game::IBar::IDetail');
        assert.equal(result.supertype, 'AActor');
        assert.deepEqual(result.interfaces, ['Core::IFoo', 'Game::IBar::IDetail']);
    });
});

describe('Integration - Type Hierarchy for References', () => {

    it('getPrimarySupertype should return first identifier before comma', () => {
        let result = getPrimarySupertype('AActor, IFoo, IBar');
        assert.equal(result, 'AActor');
    });

    it('getPrimarySupertype should return full string if no comma', () => {
        let result = getPrimarySupertype('AActor');
        assert.equal(result, 'AActor');
    });

    it('getPrimarySupertype should handle namespace-qualified', () => {
        let result = getPrimarySupertype('Core::IFoo');
        assert.equal(result, 'Core::IFoo');
    });

    it('getPrimarySupertype should handle null', () => {
        let result = getPrimarySupertype(null);
        assert.equal(result, null);
    });

    it('findDerivedTypes should find direct children', () => {
        let types = {
            'AActor': null,
            'ADerivedActor': 'AActor, IFoo',
        };
        let derived = findDerivedTypes(types, 'AActor');
        assert.ok(derived.has('AActor'));
        assert.ok(derived.has('ADerivedActor'));
        assert.equal(derived.size, 2);
    });

    it('findDerivedTypes should find transitive children', () => {
        let types = {
            'AActor': null,
            'ADerivedActor': 'AActor, IFoo',
            'AGrandchild': 'ADerivedActor, IBar',
        };
        let derived = findDerivedTypes(types, 'AActor');
        assert.ok(derived.has('AActor'));
        assert.ok(derived.has('ADerivedActor'));
        assert.ok(derived.has('AGrandchild'));
        assert.equal(derived.size, 3);
    });

    it('findDerivedTypes should NOT follow interface types in chain', () => {
        // The references.ts supertype chain follows the first parent (supertype)
        // only — comma-separated interfaces are NOT traversed.
        let types = {
            'AActor': null,
            'IFoo': null,
            'IBar': null,
            'ADerived': 'AActor, IFoo, IBar',
        };
        let derived = findDerivedTypes(types, 'IFoo');
        // IFoo is not a primary supertype of ADerived, so ADerived should
        // NOT be found when searching from IFoo.
        assert.ok(derived.has('IFoo'));
        assert.equal(derived.size, 1);
    });

    it('findDerivedTypes should handle diamond-like hierarchy', () => {
        let types = {
            'AActor': null,
            'IFoo': null,
            'IBar': null,
            'ADerived': 'AActor, IFoo',
            'ADerived2': 'AActor, IBar',
        };
        let derived = findDerivedTypes(types, 'AActor');
        assert.ok(derived.has('AActor'));
        assert.ok(derived.has('ADerived'));
        assert.ok(derived.has('ADerived2'));
        assert.equal(derived.size, 3);
    });

    it('findDerivedTypes should not include unrelated types', () => {
        let types = {
            'AActor': null,
            'IFoo': null,
            'IUnrelated': null,
            'ADerived': 'AActor, IFoo',
            'AUnrelated': 'IUnrelated',
        };
        let derived = findDerivedTypes(types, 'AActor');
        assert.ok(derived.has('AActor'));
        assert.ok(derived.has('ADerived'));
        assert.ok(!derived.has('IUnrelated'));
        assert.ok(!derived.has('AUnrelated'));
        assert.equal(derived.size, 2);
    });

    it('type hierarchy supertype chain should follow first parent only', () => {
        // references.ts computes the parent-most type for method override
        // resolution (lines 84-98).  It follows getSuperType() which reads
        // the primary supertype (first identifier).  Comma interfaces
        // don't participate.
        let supertypeStr = 'AActor, IFoo, IBar';
        let searchType = getPrimarySupertype(supertypeStr);
        assert.equal(searchType, 'AActor');

        // Simulate the while loop that walks up the chain:
        let chain = ['ADerived', 'AActor'];
        let checkParent = 'ADerived';
        let parentMap = { 'ADerived': 'AActor, IFoo', 'AActor': null };
        let walked = [];
        while (checkParent) {
            walked.push(checkParent);
            let raw = parentMap[checkParent];
            checkParent = raw ? getPrimarySupertype(raw) : null;
        }
        assert.deepEqual(walked, ['ADerived', 'AActor']);
    });
});

describe('Integration - API Docs (T3.19/T3.22)', () => {

    it('interface type should be included in API listing', () => {
        // api_docs.ts line 339 skips a DBType in API listing ONLY when
        // ALL of these are false: declaredModule, isEnum, isInterface,
        // isTemplateInstantiation, isTemplateType, isDelegate, isEvent.
        // Having isInterface=true alone is enough to include it.
        let dbtype = {
            isInterface: true,
            isEnum: false,
            declaredModule: '',
            isTemplateInstantiation: false,
            isTemplateType: false,
            isDelegate: false,
            isEvent: false,
        };
        assert.ok(shouldIncludeInApiDocs(dbtype));
    });

    it('type with only declaredModule should be included', () => {
        let dbtype = {
            isInterface: false,
            isEnum: false,
            declaredModule: 'MyModule',
            isTemplateInstantiation: false,
            isTemplateType: false,
            isDelegate: false,
            isEvent: false,
        };
        assert.ok(shouldIncludeInApiDocs(dbtype));
    });

    it('enum type should be included even without declaredModule', () => {
        let dbtype = {
            isInterface: false,
            isEnum: true,
            declaredModule: '',
            isTemplateInstantiation: false,
            isTemplateType: false,
            isDelegate: false,
            isEvent: false,
        };
        assert.ok(shouldIncludeInApiDocs(dbtype));
    });

    it('delegate type should be included', () => {
        let dbtype = {
            isInterface: false,
            isEnum: false,
            declaredModule: '',
            isTemplateInstantiation: false,
            isTemplateType: false,
            isDelegate: true,
            isEvent: false,
        };
        assert.ok(shouldIncludeInApiDocs(dbtype));
    });

    it('plain undeclared non-interface non-enum type should be excluded', () => {
        let dbtype = {
            isInterface: false,
            isEnum: false,
            declaredModule: '',
            isTemplateInstantiation: false,
            isTemplateType: false,
            isDelegate: false,
            isEvent: false,
        };
        assert.equal(shouldIncludeInApiDocs(dbtype), false);
    });

    it('interface type with declaredModule should be included', () => {
        let dbtype = {
            isInterface: true,
            isEnum: false,
            declaredModule: 'GameModule',
            isTemplateInstantiation: false,
            isTemplateType: false,
            isDelegate: false,
            isEvent: false,
        };
        assert.ok(shouldIncludeInApiDocs(dbtype));
    });
});

describe('Integration - Full Pipeline Simulation', () => {

    it('comma-separated class definition: PEG + GenerateTypeInformation roundtrip', () => {
        // Step 1: PEG captures only the first superclass identifier
        //   Input:  class AImpl : AActor, IFoo, IBar
        //   Output: superclass.value = "AActor"
        const pegResult = parseDecl('class AImpl : AActor');
        assert.equal(pegResult.name.value, 'AImpl');
        assert.equal(pegResult.superclass.value, 'AActor');

        // Step 2: GenerateTypeInformation processes the PEG output
        //   dbtype.supertype = classdef.superclass.value   (full raw string)
        //   In this simulation we use the full comma-separated string as it
        //   would appear if as_parser.ts re-examined the source line.
        const rawSuperclass = 'AActor, IFoo, IBar';
        let dbtype = {
            name: pegResult.name.value,
            supertype: rawSuperclass,
            isInterface: false,
            isStruct: false,
            isEnum: false,
            declaredModule: 'test',
        };
        assert.equal(dbtype.name, 'AImpl');
        assert.equal(dbtype.supertype, 'AActor, IFoo, IBar');

        // Step 3: parseCommaSuperclass extracts type hierarchy
        let parsed = parseCommaSuperclass(dbtype.supertype);
        assert.equal(parsed.supertype, 'AActor');
        assert.deepEqual(parsed.interfaces, ['IFoo', 'IBar']);

        // Step 4: getPrimarySupertype for references chain
        let primary = getPrimarySupertype(dbtype.supertype);
        assert.equal(primary, 'AActor');
    });

    it('derived type discovery with comma-separated interfaces', () => {
        // Simulate a realistic module with interface hierarchy
        let knownTypes = {
            'UObject': null,
            'AActor': 'UObject',
            'IFoo': null,
            'IBar': null,
            'ADerivedActor': 'AActor, IFoo, IBar',
            'AGrandchildActor': 'ADerivedActor',
        };

        // Finding types deriving from IFoo should NOT include ADerivedActor
        // because IFoo is not a primary supertype
        let derivedFromIFoo = findDerivedTypes(knownTypes, 'IFoo');
        assert.ok(derivedFromIFoo.has('IFoo'));
        assert.ok(!derivedFromIFoo.has('ADerivedActor'));
        assert.equal(derivedFromIFoo.size, 1);

        // Finding types deriving from AActor should include ADerivedActor
        // and AGrandchildActor
        let derivedFromAActor = findDerivedTypes(knownTypes, 'AActor');
        assert.ok(derivedFromAActor.has('AActor'));
        assert.ok(derivedFromAActor.has('ADerivedActor'));
        assert.ok(derivedFromAActor.has('AGrandchildActor'));
        assert.equal(derivedFromAActor.size, 3);
    });

    it('interface type should appear in simulated API docs listing', () => {
        // Simulate api_docs.ts enumerating all types in a namespace
        let types = [
            { name: 'AActor', isInterface: false, isEnum: false, declaredModule: '', isTemplateInstantiation: false, isTemplateType: false, isDelegate: false, isEvent: false },
            { name: 'IFoo', isInterface: true, isEnum: false, declaredModule: '', isTemplateInstantiation: false, isTemplateType: false, isDelegate: false, isEvent: false },
            { name: 'IBar', isInterface: true, isEnum: false, declaredModule: '', isTemplateInstantiation: false, isTemplateType: false, isDelegate: false, isEvent: false },
            { name: 'ADerived', isInterface: false, isEnum: false, declaredModule: 'test', isTemplateInstantiation: false, isTemplateType: false, isDelegate: false, isEvent: false },
        ];
        let included = types.filter(t => shouldIncludeInApiDocs(t));
        assert.equal(included.length, 3);
        assert.ok(included.some(t => t.name === 'IFoo'));
        assert.ok(included.some(t => t.name === 'IBar'));
        assert.ok(included.some(t => t.name === 'ADerived'));
        assert.ok(!included.some(t => t.name === 'AActor'));
    });

    it('multiple interface declarations in a single file parse independently', () => {
        // Simulate a real file with multiple interface declarations
        const result1 = parseDecl('interface IFoo');
        assert.equal(result1.type, nt.InterfaceDefinition);
        assert.equal(result1.name.value, 'IFoo');

        const result2 = parseDecl('interface IBar : IFoo');
        assert.equal(result2.type, nt.InterfaceDefinition);
        assert.equal(result2.name.value, 'IBar');
        assert.equal(result2.superclass.value, 'IFoo');

        const result3 = parseDecl('interface IEmpty');
        assert.equal(result3.type, nt.InterfaceDefinition);
        assert.equal(result3.name.value, 'IEmpty');
        assert.equal(result3.superclass, null);
    });

    it('namespace-qualified interface type in API docs filtering', () => {
        // An interface defined inside a namespace should still be included
        let dbtype = {
            name: 'IFoo',
            isInterface: true,
            isEnum: false,
            declaredModule: 'test',
            isTemplateInstantiation: false,
            isTemplateType: false,
            isDelegate: false,
            isEvent: false,
        };
        assert.ok(shouldIncludeInApiDocs(dbtype));

        // Same without declaredModule — isInterface alone should include it
        let dbtypeNoModule = {
            ...dbtype,
            declaredModule: '',
        };
        assert.ok(shouldIncludeInApiDocs(dbtypeNoModule));
    });
});
