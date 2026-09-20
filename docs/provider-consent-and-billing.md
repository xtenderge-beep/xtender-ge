# Provider consent, billing permission and evidence export

Implemented locally on 2026-09-20. Not deployed by this change.

## Signup

Signup has three steps (services, where you work, profile) and then a phone-code
screen. Since 2026-09-20 the last step holds full name, phone, four short facts under
"Before you register" and two unchecked consent controls. The first covers age,
terms and service notifications (excluding advertising); the
second covers the privacy notice and publication of provider contact details.
Full documents open separately, preserving the signup form. The SMS button is
enabled until a request is in progress. Missing choices show an inline message
and focus the relevant checkbox. No scroll event is required or recorded.

The server still checks explicit boolean choices and the document snapshot digest.
The archived snapshot includes the exact displayed summary, labels, confirmation
hint, document contents, language and `explicit_checkboxes_and_sms` method.
Existing historical scroll records are retained without rewriting them.

The `MASTER_REGISTERED` audit event also stores `declared_name`, the full name typed at
acceptance. Later profile edits or re-registration do not change it. It is not identity
verification: the SMS code proves control of the number only.

## Paid features

The authenticated cabinet shows both current rates and the exact charge triggers:
notification dispatch regardless of opening/reply/job, and directory contact
disclosure regardless of a call/job. The user checks an initially empty checkbox
and confirms. An existing SMS-authenticated session is required; the URL token
alone cannot accept a rate.

`PROVIDER_BILLING_ACCEPTED` archives the text, both prices, language and digest.
`master_billing_acceptances` is the current permission index. Repeated submission
is idempotent. The audit and permission commit atomically. Later charges reference
the exact billing acceptance audit ID and balance transaction ID.

No acceptance means no new notification dispatch/charge and no paid directory
disclosure. Directory cards remain visible but their contact controls are not
offered until rates are accepted. Moderation and balance requirements still apply.
Already purchased order contacts do not require acceptance of a newly changed rate.
Top-ups and promotional credits never imply billing acceptance.

Editing either rate through settings creates a fresh revision and invalidates
current permissions. Restoring an old numeric price does not revive an old consent.
The `billing_*` strings in `provider-consent-copy.js` are part of that hash. They were
reworded on 2026-09-20 without changing their substance (no "paid event" wording), which
invalidates any confirmation given earlier.
Saving an unchanged price does not revoke consent. The charge path locks the rate
settings while validating the permission. Changed billing copy also invalidates
permissions through a hash of the three-language billing text.

## Deployment impact

`schema.sql` adds `master_billing_acceptances` and the `billing_rates_revision`
setting through the normal migration-on-start flow. There is deliberately no
automatic migration from top-ups or general terms acceptance to billing consent.
**All existing providers must confirm rates in their cabinet before any new paid
events.** Profiles, balances, historical charges and accepted documents are preserved.
Staff should know this before deployment to explain why a funded account may not
receive new leads. No notifications to staff or users are sent by this change.

Use the settings service to change prices; direct database edits bypass its
revision history and are not a supported rate-change workflow.

See `contact-access-and-charge-evidence.md` for the SMS reply format (confirmed from the
production log on 2026-09-20) and the PostgreSQL concurrency verification that is still
outstanding. This code has only been tested with
mock external delivery and pg-mem; it does not establish legal enforceability.

## Unified evidence export

The existing admin consent page and JSON export now include `provider_evidence`:
billing acceptance snapshots, balance transactions, delivery attempts, linked
charge events, contact release/refusal events, current order state, category
closures and a deduplicated event timeline. Current records are explicitly
distinguished from historical audit snapshots. Missing historic records are not
inferred. Archived sent messages may include their original links; handle the
export as confidential personal and financial data.

A customer-only phone lookup does not infer provider ownership from a contact
event's `master_id`. Deleted provider audit evidence remains recoverable by phone;
rows already deleted from operational tables are not reconstructed.

## Verification

Run the standalone scripts in `tests/` using Node. New coverage includes
`signup-consent-ux.test.js`, `provider-billing.test.js`, and
`provider-evidence.test.js`. Browser checks used a 390×844 viewport for Russian and
Georgian signup and the billing panel, and a 1280×900 viewport for English signup.
Consent buttons are enabled and unchecked-state validation is visible. The two
mobile signup variants fit within the tested screen without nested scrolling.

Compensation policy is a separate business decision; this change does not add
automatic refunds or amend legal documents with an unapproved refund rule.
