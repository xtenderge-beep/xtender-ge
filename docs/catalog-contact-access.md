# Catalog contact access

A verified caller phone and provider ID identify a durable unlock. All phone and messenger channels share it. There is no expiry; a new verified caller phone is a different customer identity.

`revealPhoneForCall` locks the provider row with `FOR UPDATE`, checks access before balance/pricing, and commits the access record, debit, ledger and consent audit in one transaction. The primary key on `(master_id, caller_phone)` also prevents duplicate access records. Repeat access does not require a positive balance or fresh billing acceptance, but banned/inactive/technical providers remain unavailable.

`schema.sql` creates the contact fields and access table. `schema.postgres.sql` backfills prior paid catalogue reveals from existing ledger notes, without another debit. Both run through the existing startup migration mechanism. Deploy these files together with the application. New messenger fields default to empty: no unverified assumption that the primary phone has WhatsApp.

Providers edit customer contact channels and declared spoken languages in the authenticated Profile tab. Telegram's public username is separate from the private notification bot linkage. The public listing contains channel names, never messenger numbers/handles. Contact responses and personalized catalogue pages are not cacheable.

The language selector prioritizes the chosen language within categories. The optional checkbox filters strictly. Only self-declared spoken languages are used; UI language is not evidence of language ability.

Customer guide: `/guides/request`, `/ru/guides/request`, `/en/guides/request`; canonical/hreflang links and sitemap entries included.

Validation: existing test scripts plus `catalog-contacts.test.js` and `catalog-contact-migration.test.js`; CSS build; public pages and embedded scripts in all three locales; browser language filtering, OTP gate and responsive inspection. The in-memory test adapter does not implement PostgreSQL row locks: the concurrent-request unit test serializes transactions. Real PostgreSQL concurrency and native messenger handoff on physical devices were not exercised locally. Viber requires its app to handle the URI.

The local preview uses synthetic providers and in-memory storage. No production migration or deployment has been performed.
