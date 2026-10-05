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

## Lead link in the client's browser and return after sign-in (2026-10-06)

One browser can hold both the order owner cookie and a provider session. The owner
cookie used to win, so a provider opening their lead in the browser that created
the order saw the client page without contact buttons. Now a lead link whose
`master` parameter equals the signed-in provider opens the provider page. The
parameter still grants nothing by itself: without a session, or with another
provider's number, the page stays the owner page (`order.controller.show`).

The sign-in link shown after a 401 on a contact button carries
`/master?next=/order/<token>`. After SMS sign-in the provider returns to that
order instead of the cabinet; an already signed-in provider is redirected at
once. Only an order page path is accepted as a return target
(`master.controller.orderReturn`).

## Personal lead link (2026-10-06)

Owner decision 2026-10-06. The lead link sent by SMS or Telegram is now
`/order/<token>?k=<key>` (`leadLink.service.js`, table `lead_links`). The key is
22 random URL-safe characters, one per order and provider; the table keeps only
SHA-256 hashes of the key and of the device cookie. The exact SMS text with the
link is still kept in the charge evidence (`LEAD_CHARGE_ACCEPTED.message_body`).

- The key identifies the provider on the order page without a cabinet sign-in:
  the page shows the provider view, records the view and releases the contact.
  It never shows the balance or a cabinet link, and it grants no cabinet access.
- The contact rules are unchanged: `orderContact.reveal` still requires an
  active, not banned provider with a lead charge for this order, the same
  technical group and an open matching need. The audit event records how the
  provider was recognised: `access: 'link'` or `'session'`.
- **First browser only.** The first action from the page (the view logged by
  the page script, Call or WhatsApp — a POST) binds the key to that browser
  through the `lead_device` cookie (httpOnly, one per browser for all leads).
  Opening the page with a GET binds nothing, so link-preview robots in
  messengers cannot take the link. In any other browser the same link shows the
  order text, the notice `contact_link_taken` and the sign-in link; the contact
  request returns 401 with code `link_taken`.
- A cabinet session outranks the key: a signed-in provider acts as themselves,
  another provider's link is neither usable nor bound in their browser. The
  provider's own unused link is bound to the browser where they are signed in.
- Sending again to the same provider replaces the key and clears the binding;
  the old link stops working.
- Known limit, accepted by the owner: a link forwarded before the provider
  opens it is bound to whoever opens it first. The provider then signs in with
  an SMS code on their own device. A provider can always forward the phone
  number itself; the key only stops the link from working as a pass for others.

Without a language cookie the provider page opens in the provider's saved
cabinet language (`masters.language`).
