import { existsSync, lstatSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
/**
 * Shared path-containment helpers for clean-checkout acceptance / reconstruction. Both
 * `command-acceptance.ts` (git-archive overlay) and `worktree-evidence.ts` (worktree+apply
 * reconstruction) write operator-controlled files into a sandbox and must refuse any path that
 * escapes it — lexically (`..`, absolute) or via a symlink ancestor an executor could have committed
 * at HEAD to redirect a write out of the sandbox.
 */
export function isLexicalRelSafe(rel) {
    if (!rel || rel.startsWith('/') || rel.startsWith('\\'))
        return false;
    return !rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '' || seg === '.');
}
/**
 * Resolve a sandbox-relative path to a write target inside `cleanRealRoot`, refusing if it escapes
 * the root OR if any existing ancestor segment is a symlink. Returns null to skip the write.
 */
export function confinedTarget(cleanRealRoot, rel) {
    if (!isLexicalRelSafe(rel))
        return null;
    const target = resolve(cleanRealRoot, rel);
    const lexRel = relative(cleanRealRoot, target);
    if (lexRel === '..' || lexRel.startsWith(`..${sep}`))
        return null;
    let cur = cleanRealRoot;
    for (const segment of lexRel.split(sep)) {
        cur = join(cur, segment);
        if (existsSync(cur) && lstatSync(cur).isSymbolicLink())
            return null;
    }
    return target;
}
