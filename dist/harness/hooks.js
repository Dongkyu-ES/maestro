export function runHooks(event, handlers, ctx) {
    const ordered = handlers
        .filter((handler) => handler.event === event)
        .slice()
        .sort((left, right) => {
        const priority = (left.priority ?? 0) - (right.priority ?? 0);
        return priority === 0 ? left.id.localeCompare(right.id) : priority;
    });
    for (const handler of ordered) {
        const outcome = handler.run(ctx);
        if (outcome.decision !== 'continue')
            return outcome;
    }
    return { decision: 'continue', hookId: 'none' };
}
