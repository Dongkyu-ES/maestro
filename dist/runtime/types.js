export function unsupportedResult(verb, kind, evidence = []) {
    return { status: 'unsupported', evidence, message: `${kind} adapter does not yet prove ${verb}` };
}
