"use strict";

/**
 * PEG grammar test runner for angelscript.pegjs
 *
 * Reads test.as and tests each interface/class/method header against
 * the appropriate PEG start rule.
 *
 * The grammar's interface_decl / class_decl only parse declaration headers
 * (not body { ... } blocks), as it's designed for incremental LSP parsing.
 * This runner extracts declaration headers from the full AS test file and
 * tests them individually.
 */

const path = require("path");
const fs = require("fs");

const PARSER_PATH  = path.join(__dirname, "angelscript.js");
const TEST_PATH    = path.join(__dirname, "test.as");

// ---------------------------------------------------------------------------
// Extract declaration headers from full AS source
// ---------------------------------------------------------------------------

/**
 * Extracts header-only test cases from the AS source by stripping bodies.
 * Returns an array of { text, label } objects.
 */
function extractHeaders(source) {
  const cases = [];

  // Remove block comments and string literals to avoid false matches
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"([^"\\]|\\.)*"/g, '""');

  // Split by top-level semicolons or closing braces
  const lines = cleaned.split("\n");

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    i++;

    // Skip blank lines and line comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      continue;
    }

    // interface declaration header
    // e.g. "interface IEmpty {};" -> "interface IEmpty"
    // e.g. "interface IBasic" or "interface IBasic : ISuper"
    const ifaceMatch = trimmed.match(/^(interface\s+\w+(?:\s*:\s*\w[\w\s,]*)?)/);
    if (ifaceMatch) {
      cases.push({ text: ifaceMatch[1].trim(), label: ifaceMatch[1].trim() });
      continue; // body will be on subsequent lines
    }

    // class declaration header
    const classMatch = trimmed.match(/^(class\s+\w+(?:\s*:\s*[\w\s,]+)?)/);
    if (classMatch) {
      cases.push({ text: classMatch[1].trim(), label: classMatch[1].trim() });
      continue;
    }

    // struct declaration header
    const structMatch = trimmed.match(/^(struct\s+\w+)/);
    if (structMatch) {
      cases.push({ text: structMatch[1], label: structMatch[1] });
      continue;
    }

    // UFUNCTION + method declaration (possible multi-line)
    if (/^UFUNCTION\b/.test(trimmed)) {
      // Collect UFUNCTION + method signature until we hit a method body { or ;
      let block = trimmed + "\n";
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next || next.startsWith("//")) { i++; continue; }
        if (next.startsWith("UFUNCTION") || next.startsWith("UPROPERTY") ||
            next.startsWith("interface") || next.startsWith("class") ||
            next.startsWith("struct") || next.startsWith("enum")) {
          break;
        }
        // Stop at body start { or semicolon-terminated signature
        if (/[{]/.test(next) || /;[ \t]*(\/\/.*)?$/.test(next)) {
          block += next.replace(/\s*\{.*$/, "").trim();
          if (block.trim().endsWith(";")) {
            block = block.trim().slice(0, -1);
          }
          i++;
          break;
        }
        block += next + " ";
        i++;
      }
      const text = block.trim();
      if (text) {
        cases.push({ text, label: text.split("\n")[0].trim() });
      }
      continue;
    }

    // UPROPERTY + property declaration
    if (/^UPROPERTY\b/.test(trimmed)) {
      let block = trimmed + "\n";
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next || next.startsWith("//")) { i++; continue; }
        if (/[{;]/.test(next) || /^U(FUNCTION|PROPERTY)\b/.test(next)) {
          block += next.replace(/[;{].*$/, "").trim();
          i++;
          break;
        }
        block += next + " ";
        i++;
      }
      const text = block.trim();
      if (text) {
        cases.push({ text, label: text.split("\n")[0].trim() });
      }
      continue;
    }

    // Standalone method: return_type name(...) [const] [override] [final]
    const methodMatch = trimmed.match(
      /^(\w[\w\s*&<>]*\s+\w+\s*\([^)]*\)\s*(?:const|override|final|property)*(?:\s+const|override|final|property)*)/
    );
    if (methodMatch && !/^(interface|class|struct|enum|namespace)\b/.test(trimmed)) {
      cases.push({ text: methodMatch[1].trim(), label: methodMatch[1].trim() });
      continue;
    }

    // Variable declaration at global scope: TypeName VarName
    const varMatch = trimmed.match(/^([\w:]+(?:\s*<[^>]*>)?\s+\w+)\s*;/);
    if (varMatch && !/^(return|if|for|while|switch|case|default)\b/.test(trimmed)) {
      cases.push({ text: varMatch[1], label: varMatch[1] });
      continue;
    }
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Determine start rule for a header text
// ---------------------------------------------------------------------------

function detectStartRule(text) {
  const fl = text.trim();
  if (/^interface\b/.test(fl)) return "start_global";
  if (/^class\b/.test(fl))     return "start_global";
  if (/^struct\b/.test(fl))    return "start_global";
  if (/^enum\b/.test(fl))      return "start_global";
  if (/^UFUNCTION\b/.test(fl) || /^UPROPERTY\b/.test(fl)) return "start_class";
  // Access specifier
  if (/^(public|private|protected)\s*:/.test(fl)) return "start_class";
  // Method signature: return_type name(...)
  if (/^\w[\w\s*&<>]*\s+\w+\s*\(/.test(fl)) return "start_class";
  // Constructor/destructor
  if (/^~\w+/.test(fl) || /^\w+\s*\(/.test(fl)) return "start_class";
  // Default statement
  if (/^default\s/.test(fl)) return "start_class";
  // Variable declaration with type
  if (/^[\w:]+[\s*&<>]*\s+\w+\s*$/.test(fl)) return "start_global";
  return "start_global";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function safeParse(parser, text, startRule) {
  try {
    const result = parser.parse(text, { startRule });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message.split("\n")[0].substring(0, 200) };
  }
}

function tryAllStartRules(parser, text) {
  for (const rule of ["start_global", "start_class", "start"]) {
    const a = safeParse(parser, text, rule);
    if (a.ok) return { ok: true, startRule: rule };
  }
  return { ok: false, startRule: null, error: "No start rule matched" };
}

function main() {
  const parser = require(PARSER_PATH);
  const source = fs.readFileSync(TEST_PATH, "utf8");

  const testCases = extractHeaders(source);

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < testCases.length; i++) {
    const { text, label } = testCases[i];
    const defaultRule = detectStartRule(text);
    let outcome;

    // Try the detected rule first
    const primary = safeParse(parser, text, defaultRule);
    if (primary.ok) {
      outcome = { status: "pass", startRule: defaultRule, error: null };
      passed++;
    } else {
      // Fallback: try all rules
      const fallback = tryAllStartRules(parser, text);
      if (fallback.ok) {
        outcome = { status: "pass", startRule: `${defaultRule}→${fallback.startRule}`, error: null };
        passed++;
      } else {
        outcome = { status: "fail", startRule: defaultRule, error: primary.error };
        failed++;
      }
    }

    if (outcome.status === "pass") {
      console.log(`  PASS  [${outcome.startRule}] #${i + 1}: ${label.substring(0, 55)}`);
    } else {
      console.log(`  FAIL  [${outcome.startRule}] #${i + 1}: ${label.substring(0, 55)}`);
      console.log(`        ${outcome.error}`);
    }
  }

  // Summary
  console.log(`\n${"=".repeat(56)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(56)}`);

  if (failed === 0) {
    console.log("\nAll interface patterns parse correctly in the PEG grammar.");
  }

  process.exit(failed > 0 ? 2 : 0);
}

main();
