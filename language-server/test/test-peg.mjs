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

// =====================//
//        Tests          //
// =====================//

describe('PEG Grammar - Interface Declaration', () => {

    it('T3.2: should parse interface IFoo (basic declaration header)', () => {
        const result = parseDecl('interface IFoo');
        assert.ok(result, 'Expected a parse result');
        assert.equal(result.type, nt.InterfaceDefinition,
            `Expected InterfaceDefinition (${nt.InterfaceDefinition}), got ${result.type}`);
        assert.equal(result.name.value, 'IFoo', `Expected name "IFoo", got "${result.name.value}"`);
        assert.equal(result.superclass, null, 'No superclass should yield null');
    });

    it('T3.3: should parse interface IEmpty (no superclass, no macro)', () => {
        const result = parseDecl('interface IEmpty');
        assert.ok(result, 'Expected a parse result');
        assert.equal(result.type, nt.InterfaceDefinition, 'Expected InterfaceDefinition');
        assert.equal(result.name.value, 'IEmpty');
        assert.equal(result.superclass, null);
    });

    it('T3.6: should parse interface IFoo : IInterface (with inheritance)', () => {
        const result = parseDecl('interface IFoo : IInterface');
        assert.ok(result, 'Expected a parse result');
        assert.equal(result.type, nt.InterfaceDefinition, 'Expected InterfaceDefinition');
        assert.equal(result.name.value, 'IFoo');
        assert.ok(result.superclass, 'Expected a superclass');
        assert.equal(result.superclass.value, 'IInterface',
            `Expected superclass "IInterface", got "${result.superclass?.value}"`);
    });

    it('should parse interface with namespace-qualified superclass', () => {
        const result = parseDecl('interface IFoo : Core::IInterface');
        assert.ok(result, 'Expected a parse result');
        assert.equal(result.type, nt.InterfaceDefinition);
        assert.equal(result.name.value, 'IFoo');
        assert.ok(result.superclass);
        assert.ok(result.superclass.value.includes('::'), 'Should have namespace separator');
    });
});

describe('PEG Grammar - Class with Interface Implementation', () => {

    it('T3.17: should parse separate interface declarations', () => {
        const r1 = parseDecl('interface IFoo');
        assert.equal(r1.type, nt.InterfaceDefinition);
        assert.equal(r1.name.value, 'IFoo');

        const r2 = parseDecl('interface IBar');
        assert.equal(r2.type, nt.InterfaceDefinition);
        assert.equal(r2.name.value, 'IBar');
    });

    it('T3.17: class with single interface in superclass (comma-separated list handled by as_parser)', () => {
        // The PEG grammar's class_decl only captures the first identifier after ':'.
        // Comma-separated interface lists are handled by as_parser.ts's GenerateTypeInformation.
        // This test verifies the first superclass name is captured correctly.
        const result = parseDecl('class AImpl : AActor');
        assert.equal(result.type, nt.ClassDefinition, 'Expected ClassDefinition for AImpl');
        assert.equal(result.name.value, 'AImpl');
        assert.ok(result.superclass, 'Expected a superclass string');
        assert.ok(result.superclass.value.includes('AActor'), 'Should contain AActor');
    });
});

describe('PEG Grammar - Regression (T3.21)', () => {

    it('should still parse classes correctly', () => {
        const result = parseDecl('class ATest : AActor');
        assert.ok(result);
        assert.equal(result.type, nt.ClassDefinition);
        assert.equal(result.name.value, 'ATest');
        assert.equal(result.superclass?.value, 'AActor');
    });

    it('should still parse classes without superclass', () => {
        const result = parseDecl('class ATest');
        assert.ok(result);
        assert.equal(result.type, nt.ClassDefinition);
        assert.equal(result.name.value, 'ATest');
        assert.equal(result.superclass, null);
    });

    it('should still parse structs correctly', () => {
        const result = parseDecl('struct FTest');
        assert.ok(result);
        assert.equal(result.type, nt.StructDefinition);
        assert.equal(result.name.value, 'FTest');
    });

    it('should still parse enums correctly (PEG start_enum parses value lists, not declarations)', () => {
        // Note: start_enum parses enum value lists (content between braces), not the enum declaration header.
        // The enum_decl within global_declaration handles the "enum ETest" header.
        const result = parseDecl('enum ETest');
        assert.ok(result);
        assert.equal(result.type, nt.EnumDefinition);
        assert.equal(result.name.value, 'ETest');
    });

    it('should not confuse interface with struct_decl', () => {
        const result = parseDecl('struct FTest');
        assert.equal(result.type, nt.StructDefinition);
        assert.equal(result.name.value, 'FTest');
    });

    it('should not confuse interface with class_decl', () => {
        const result = parseDecl('class ATest');
        assert.equal(result.type, nt.ClassDefinition);
        assert.equal(result.name.value, 'ATest');
    });
});
