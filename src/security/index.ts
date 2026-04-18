export { InjectionScanner, type ScanResult, type ScanMatch } from "./scanner.js";
export { INJECTION_PATTERNS, type InjectionPattern } from "./patterns.js";
export { wrapExternal, unwrapExternal, isWrapped } from "./delimiters.js";
export { ProvenanceRegistry } from "./provenance.js";
export { redact } from "./redactor.js";
export { audit, type AuditEntry } from "./audit.js";
