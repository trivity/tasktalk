# Read-flow smoke test (manual, after Plan C lands)

Prereqs: Plan A + B + C deployed. A connected user with synced ClickUp.

- [ ] "How many tasks do I have?" → answers, tool: query_tasks (snapshot)
- [ ] "What's overdue?" → answers, tool: query_tasks with due_before
- [ ] "Who's overloaded?" → answers, tool: aggregate_workload
- [ ] "What did the team ship last week?" → answers, tool: aggregate_throughput
- [ ] "What's the status of task <known-id>?" → answers, tool: get_task (live)
- [ ] "Show me the org structure" → answers, tool: list_org_structure
- [ ] After 6 minutes of no sync, "what tasks are open" should report a live router_path (or fallback)
- [ ] Asking "what is Sarah working on?" → assistant declines and offers an aggregate instead (named-person guardrail)
