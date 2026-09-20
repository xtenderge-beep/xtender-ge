# Contact access and lead charge evidence

Implemented 2026-09-20. No database migration is required.

## Contact access

Order HTML contains no customer phone field or prebuilt phone/WhatsApp link.
Both buttons POST to `/api/orders/:token/contact` on every click. Responses and
order pages use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
The session determines the provider; a `master` URL/body parameter grants no access
and no longer exposes another provider's cabinet token or balance.

The provider must be active, not banned, in the same technical/real routing group,
in an order target category, and have a historical lead charge for this order.
Balance depletion after purchase does not remove contact access. Missing sessions
see an explicit sign-in link. After signing in, the provider can reopen the lead.

The service locks the provider and then the order, checks live status and category
closure, and commits `ORDER_CONTACT_RELEASED` or `ORDER_CONTACT_DENIED` before
returning a contact. Full and category closure use the same order lock. Release
means the server authorized disclosure; it does not prove a call was made.
Closing cannot revoke contacts already returned, saved, embedded in old pre-deploy
pages, or included by a customer in free-text descriptions or attachments.

## Charges

`notifyMasters` checks live order/category status and previous lead charges under
locks. Successful retries do not send or charge the same provider/order again.
After channel acceptance, the debit, `dispatch_deliveries` update, and
`LEAD_CHARGE_ACCEPTED` audit event commit in one transaction. The audit includes
the balance transaction ID, amount, before/after balances, dispatch run, category,
channel, message body, gateway ID and response. Audit failure rolls back the debit.
Low-balance reminders run after this transaction and cannot undo a valid charge.

SMS acceptance now rejects HTTP-200 error/unknown payloads. Accepted formats are
positive numeric IDs with at least six digits, `OK: <positive numeric ID>` /
`OK <positive numeric ID>`, or JSON containing a message ID and explicit
`ok: true`, `success: true`, or an accepted status. Telegram requires `ok: true`
and `result.message_id`. Requests time out after 15 seconds.

**Real gateway format (confirmed 2026-09-20 from the production log):** an accepted
message returns HTTP 200 with `0000-api_<hex>.<digits>`, for example
`0000-api_6ab02a827ac137.36558917`. Four digits are the status, `0000` is the only
accepted one, and the rest is the message id, stored whole as the provider
reference. A rejected request returns another status and HTTP 501, for example
`0003-api_...` for a call without parameters. The first fail-closed version did not
know this format, so from its release at 14:07 until the fix every real acceptance
was treated as a failure: OTP sending, cabinet and admin login codes, and SMS lead
notifications were affected. Unknown formats still fail closed. The formal contract of
the gateway is still not in the repository, so any new status code needs the operator's
documentation. Tests use mock gateways and do not send real messages.

Gateway acceptance is not handset delivery. No delivery-receipt callback is
implemented; audit explicitly stores `delivery_status: unknown`. If a provider
accepts a message but the network times out or the DB transaction subsequently
fails, there is no charge; a retry may send another notification. Exactly-once
external delivery requires provider idempotency/reconciliation support and is
not claimed by this change. Existing ambiguous pending runs need operator review.

## Verification

- `order-contact.test.js`: both contact channels, fresh checks on the same open
  page, session forgery/revocation, full/category closure, HTML privacy, audit failure.
- `sms-acceptance.test.js`: positive receipts, HTTP-200 error payloads, unknown
  payloads and network failures.
- `lead-charge-evidence.test.js`: linked evidence, duplicate retries, rejected
  sends, audit rollback, closed categories, Telegram and fallback SMS.

Database tests use pg-mem. Its transaction snapshots verify rollback logic but
do not emulate PostgreSQL row-lock contention; concurrency is enforced in SQL
and should also be verified against staging PostgreSQL before deployment.

Registration UX, tariff acceptance and the combined dispute export are described
in `provider-consent-and-billing.md`. Refund policy remains a separate decision.
