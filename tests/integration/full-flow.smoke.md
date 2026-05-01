# Full-flow smoke test (manual, after Plan D lands)

## Onboarding
- [ ] New invitee receives magic link, clicks, lands on `/onboarding`
- [ ] Wizard walks through Welcome -> Connect -> Estimate -> Syncing -> Done
- [ ] If workspace estimate > 250 tasks, the add-on warning shows
- [ ] Sync progress bar updates as worker indexes lists

## Read flow (regression of Plan C)
- [ ] All 8 read tools answer correctly via Claude

## Write flow
- [ ] "Mark task X as done" -> confirm card with status diff -> click Confirm -> assistant streams confirmation message -> ClickUp shows the change
- [ ] "Comment on task X: looks good" -> confirm card with text -> click Confirm
- [ ] "Create a follow-up task in <list>" -> confirm card with new fields -> click Confirm
- [ ] "Delete task X" -> confirm card requires typing DELETE -> button activates only after correct input
- [ ] Cancel any of the above -> assistant gracefully continues without the write

## Undo
- [ ] After a successful update, click the Undo chip -> before/after reverts -> audit_log row marked undone

## System events
- [ ] In one tab, ask about task X. In ClickUp, change task X status. Within ~5s, an inline blue notice appears in the conversation.

## Polish
- [ ] Theme toggle: System / Dark / Light all switch
- [ ] Right sidebar collapses and persists per-account
- [ ] Tool-call pills hidden by default; hover reveals tool name + router_path
- [ ] Suggested prompts appear on empty conversation; clicking fills the composer

## Deploy
- [ ] Production deploy succeeds; both services running on Railway
- [ ] OAuth allowlist active; teammates can connect from prod URL
