export type LifecycleEvent =
  | 'BeforeContextBuild'
  | 'BeforeToolExecution'
  | 'BeforeStateTransition'
  | 'AfterStateTransition';

export interface HookOutcome {
  decision: 'continue' | 'block' | 'require_approval';
  reason?: string;
  hookId: string;
}

export interface HookHandler {
  id: string;
  event: LifecycleEvent;
  priority?: number;
  run(ctx: unknown): HookOutcome;
}

export function runHooks(event: LifecycleEvent, handlers: HookHandler[], ctx: unknown): HookOutcome {
  const ordered = handlers
    .filter((handler) => handler.event === event)
    .slice()
    .sort((left, right) => {
      const priority = (left.priority ?? 0) - (right.priority ?? 0);
      return priority === 0 ? left.id.localeCompare(right.id) : priority;
    });

  for (const handler of ordered) {
    const outcome = handler.run(ctx);
    if (outcome.decision !== 'continue') return outcome;
  }

  return { decision: 'continue', hookId: 'none' };
}
