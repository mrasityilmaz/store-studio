---
name: store-api
description: Uses the full App Store Connect and Google Play Developer APIs through store-studio's reference, read and write tools. Use for anything beyond screenshots and store text, such as shipping a version (attach a build, age rating, encryption, submit for review, release, phased rollout), customer reviews and replies, analytics, sales and finance reports, pricing, in-app purchases and subscriptions, custom product pages, experiments, TestFlight, Play tracks and staged rollouts, and the Play Data safety form.
---

# Everything else in the store APIs

## How to work

1. **Look it up.** `asc_api_docs` / `play_api_docs` with `search`, then with
   `path` + `method` (or a Play `id`). They read the official references: Apple's
   OpenAPI spec and Google's discovery document, cached locally and refreshed
   every few weeks. Don't guess paths or body shapes from memory.
2. **Read.** `asc_api_get` / `play_api_get`. Keep responses small: request only
   the fields you need (`fields[apps]=name,bundleId`), use `filter[...]` and `limit`
   (App Store max 200), and `include` for related data. Use `all_pages` to follow
   `links.next`. For anything large, pass `save_to` and analyze the file locally.
3. **Change.** `asc_api_write` / `play_api_write`. Always dry-run first and show
   the user the request, the current state and the impact lines. Only run with
   `dry_run: false` after the user confirms that exact change in chat. For Play
   changes inside an edit, use `in_edit`: the dry run sends the change into a
   temporary edit so Google validates it, then throws the edit away.
4. **Verify.** Read the resource again and report what changed.

Prefer the task tools where they exist: screenshots (`*_screenshots_push`), store
text (`asc_metadata_update`, `play_listing_update`), new versions
(`asc_version_create`). They handle uploads and edge cases the generic tools don't.

Not available, on purpose: refunds, purchase revocations, order actions and
user or permission management. Point the user to the store console for those.

Not available in any public API: Apple's App Privacy details (the privacy
"nutrition label"). They can only be edited in App Store Connect on the web.
The privacy policy URL is regular store text (`privacy_policy_url` in
`asc_metadata_update`). Google Play's Data safety form *is* in the API (below).

## App Store Connect notes

- JSON:API everywhere. Bodies look like
  `{"data": {"type": "…", "id": "…", "attributes": {…}, "relationships": {"x": {"data": {"type": "…", "id": "…"}}}}}`.
- To-many relationships (`…/relationships/{name}`, where `asc_api_docs` shows
  `data*: [ … ]`) take a list of identifiers instead:
  `{"data": [{"type": "builds", "id": "…"}]}`. POST adds links, DELETE removes
  them (the linked resources stay), PATCH replaces the whole list. The dry run
  shows the ids linked now and what will be added or removed. Success is `204`
  with no content.
- IDs come from reads; look them up instead of assuming.
- Versions come back in no documented order; sort them yourself.

### Ship a version

1. Version: `asc_version_create`, then `asc_metadata_update` for what's new.
2. IPA, Mac only: `asc_ipa_upload` with the absolute path of the `.ipa`. It runs
   `xcrun altool` using the configured key, so it works on any Mac that has
   Xcode and the plugin options. Dry run first. Apple rejects a build number
   that is already uploaded. A non-Mac host stops with an error. Then attach
   the processed build: `GET /v1/builds` with `filter[app]`, `filter[preReleaseVersion.version]`
   and `filter[processingState]=VALID`, then `PATCH /v1/appStoreVersions/{id}/relationships/build`
   with `{"data": {"type": "builds", "id": "…"}}`.
3. Encryption: if the build asks, `PATCH /v1/builds/{id}` with `usesNonExemptEncryption`.
4. Age rating: `GET /v1/appInfos/{id}/ageRatingDeclaration`, then
   `PATCH /v1/ageRatingDeclarations/{id}`.
5. Release type: `PATCH /v1/appStoreVersions/{id}` with `releaseType`
   (`MANUAL`, `AFTER_APPROVAL`, `SCHEDULED` + `earliestReleaseDate`). Phased release:
   `POST /v1/appStoreVersionPhasedReleases`.
6. Submit: `POST /v1/reviewSubmissions` (platform + app), `POST /v1/reviewSubmissionItems`
   (reviewSubmission + appStoreVersion), then `PATCH /v1/reviewSubmissions/{id}`
   with `submitted: true`. This sends the app to App Review, so confirm it separately.
7. Release a version held for manual release: `POST /v1/appStoreVersionReleaseRequests`.

### Customer reviews

`GET /v1/apps/{id}/customerReviews` with `sort=-createdDate`, `filter[rating]=1,2`,
`exists[publishedResponse]=false` and `include=response`. Reply with
`POST /v1/customerReviewResponses` (`responseBody` + relationship `review`).
Replies are public: show the user the exact text first.

### Analytics reports

1. Once per app, request access: `POST /v1/analyticsReportRequests` with
   `accessType` `ONGOING` (daily from now on) or `ONE_TIME_SNAPSHOT` (history), and
   relationship `app`. Check `GET /v1/apps/{id}/analyticsReportRequests` first so
   you don't create duplicates. Data appears after Apple processes it, which can
   take a day or more.
2. `GET /v1/analyticsReportRequests/{id}/reports` with `filter[category]`
   (`APP_STORE_ENGAGEMENT`, `APP_USAGE`, `COMMERCE`, `FRAMEWORK_USAGE`, `PERFORMANCE`).
3. `GET /v1/analyticsReports/{id}/instances` with `filter[granularity]`
   (`DAILY`, `WEEKLY`, `MONTHLY`) and optionally `filter[processingDate]`.
4. `GET /v1/analyticsReportInstances/{id}/segments`, then `asc_download_file`
   each segment `url` to a local `.tsv`.
5. Analyze the files locally (Python or the shell) and report findings with the
   numbers. Say which dates and report the figures came from.

### Sales and finance reports

`asc_api_get` on `/v1/salesReports` or `/v1/financeReports` with `save_to`; the
gzip is unpacked into a tab-separated file. They need `filter[vendorNumber]`,
which the user finds in App Store Connect under Payments and Financial Reports.
Sales reports need `filter[reportType]`, `filter[reportSubType]`, `filter[frequency]`
and `filter[reportDate]`. Check the valid combinations with `asc_api_docs`.

### TestFlight builds and groups

Give a beta group a build with `POST /v1/betaGroups/{id}/relationships/builds`
and `{"data": [{"type": "builds", "id": "…"}]}`, or put one build in several
groups with `POST /v1/builds/{id}/relationships/betaGroups`. DELETE on the same
paths takes the build away again. Testers may be notified, so confirm the group
and build with the user. External groups only get a build once it passes beta
app review (`POST /v1/betaAppReviewSubmissions`).

### Other areas

Custom product pages (`appCustomProductPages…`), product page experiments
(`appStoreVersionExperiments…`), in-app purchases and subscriptions, pricing
(`appPriceSchedules`, `subscriptionPrices`), availability, TestFlight groups and
testers, and in-app events all follow the same pattern: look up, read, dry-run,
confirm, write. Price and availability changes affect customers, so say so plainly.

## Google Play notes

- Paths sit under `androidpublisher/v3/`, e.g. `applications/{package}/reviews`.
- Anything under `edits/` (listings, details, tracks, testers, country
  availability) must use `in_edit` with `package`, and the path is relative to the
  edit, e.g. `tracks/production`.
- Committed edits are not sent for review unless the user asks
  (`send_for_review`); they wait in Play Console under changes not yet sent for review.

### Upload a release

`play_bundle_upload` with the absolute path of the `.aab`, the track, `rollout`
(e.g. 0.2) and `release_notes` (500 characters per language). Its dry run uploads
into a temporary edit and runs Google's commit checks, so signing or version-code
problems show up before anything is released. Use `draft: true` to finish the
release in Play Console instead.

### Staged rollout

`play_api_get` `tracks/production` (in_edit), then `play_api_write` `PUT tracks/production`
with `releases: [{"versionCodes": ["…"], "status": "inProgress", "userFraction": 0.1, "releaseNotes": […]}]`.
To widen it, raise `userFraction`. To finish, use `status: "completed"`. To stop, `status: "halted"`.

### Reviews

`GET applications/{package}/reviews` returns only reviews created or changed in
about the last week. Reply with `POST applications/{package}/reviews/{id}:reply`
and `{"replyText": "…"}` (350 characters max). Replies are public.

### Data safety

`POST applications/{package}/dataSafety` with `{"safetyLabels": "<CSV>"}`. Get the
CSV from Play Console (App content > Data safety > Export to CSV), edit it, and
send it via `body_file`. It replaces the whole declaration, so diff the old and new
CSV for the user before confirming.

### Subscriptions and in-app products

`applications/{package}/subscriptions`, `…/inappproducts` and `…/oneTimeProducts`:
read freely. Price or offer changes affect customers, so confirm them one by one.
