# Development and release workflow

## Branches

- **`dev`** is the default and integration branch. Commit small iterations here, or use short-lived branches with PRs into `dev`. Pushes produce development executables; they are not stable releases.
- **`production`** is the reviewed release/site checkpoint. Promote `dev` through a PR; do not develop directly here. Landing-page changes follow the same path.
- There is no `main`. Existing feature branches can be retained until their work is integrated; no workflow depends on a particular feature branch.

```text
iteration / feature branch → dev → promotion PR → production
                              │                       │
                         test executables        live landing page
                                                 deliberate releases
```

## Checks and development downloads

[Web](../.github/workflows/web.yml) checks the editor build/tests, plugin SDK, and landing build. It also rejects production PRs not coming from this repository's `dev` branch.
[System controls](../.github/workflows/system-controls.yml) runs native/fake-backed checks on macOS, Windows, and Linux. Both run on PRs targeting either long-lived branch and pushes to either branch. Superseded runs are canceled; jobs have read-only repository permissions and no deployment credentials.

After a successful `dev` push, open **Actions → System controls (cross-platform) → the run → Artifacts**. Downloads are named `zdeck-dev-<runner OS>-<architecture>-<commit>`, retained for seven days, and contain a bare debug executable (`deck` or `deck.exe`). They are **not installers**, have no release signing/notarization, and need the platform runtime prerequisites. GitHub sign-in is required to download. No automatic updates or public release publishing occurs. These builds use normal application storage: back up important decks before testing; they are not a separate isolated dev app.

The desktop workflow can also be dispatched manually to run checks; executable uploads occur only on `dev` pushes. See [development](development.md) for local commands and verification limits.

## Website deployments (Vercel)

The existing [Vercel configuration](../vercel.json) builds the separate landing page (`npm run landing:build`, `dist-landing/`). This does not deploy the desktop editor or native app.

In the connected Vercel project's Git settings:

1. Set **Production Branch** to `production` (do not leave it tracking the GitHub default branch).
2. Keep Git-based preview deployments enabled for `dev` and PR branches. Optionally assign a stable preview domain to `dev`.
3. Confirm the first `dev` push creates a preview and the first `production` promotion updates only the intended production domain. Branch naming alone does not configure Vercel or gate its deployments on GitHub CI.

Do not add Vercel credentials to test jobs; the existing Git integration is sufficient. These dashboard settings must be applied separately from the repository changes.

## Promoting a release

1. Push the intended changes to `dev`; review the web and three desktop check results, plus relevant manual/native verification. Run or inspect the downloadable dev build on affected platforms.
2. Open a `dev` → `production` PR. Include changes, exact checks, unverified platforms, and persistence/permission risks. Avoid squashing long-lived-branch promotions: use a merge commit to retain ancestry.
3. Merge only after the required checks pass. Vercel deploys the landing page from `production` once configured above. Verify the live site; a green build is not a live-site check.
4. If publishing a version, use the exact reviewed production commit, update app/SDK versions and release notes deliberately, and create a draft release first. Do not move an existing version tag. Publish only verified artifacts; a debug executable is not a verified installer. SDK publication remains a separate explicit action ([plugins](plugins.md#sdk-publication-maintainer-only-010-published)).
5. Sync production's merge commit back into `dev` before the next promotion (`git merge origin/production` on a clean, up-to-date `dev` checkout, or a sync PR). Revert a bad change in `dev`, promote the fix, and keep history; do not reset a shared branch.

There is intentionally no automatic stable publishing/signing workflow yet: installer packaging and signing are not verified on all supported platforms. When added, build without release secrets, then verify/sign/publish in separate protected jobs. Do not give jobs running PR code production credentials.

## Recommended GitHub settings

- **Default branch:** `dev`; PRs and agent work normally start here.
- **`dev` ruleset:** block deletion and force pushes. Direct iteration can remain allowed; require PRs if concurrent agent work starts causing collisions.
- **`production` ruleset:** block deletion/force pushes, require PRs, resolved conversations, **Web checks** and all three desktop `test (...)` checks. Select the actual check names after their first runs. Require the branch to be up to date; keep merge commits enabled for promotions. Restrict bypasses to deliberate maintainer emergencies.
- **Approvals:** require one independent approval when another trusted reviewer is available. A solo owner cannot approve their own PR, so don't enable a requirement that leaves nobody able to merge. Add code-owner review for `.github/` when you have an eligible trusted reviewer.
- **Actions:** retain read-only default workflow permissions; keep "Allow GitHub Actions to create and approve pull requests" off unless a specific reviewed bot needs it. Never use `pull_request_target` to execute PR code with secrets.
- **Future publishing:** use a `production` environment restricted to that branch, with approval for signing/publishing; prefer short-lived OIDC credentials where supported. Vercel Git deployments need their own access/protection settings; a GitHub environment does not protect them automatically.

The rules above are recommendations, not assertions that GitHub/Vercel settings are already enabled. Action SHAs are pinned; Dependabot proposes monthly grouped action updates against `dev`.

## Inspiration and next steps

Inspired by Hex's [test builds](https://github.com/anomalyco/hex/blob/2548a1b876c496cda30647cc1b0736cd4b9299c0/.github/workflows/test-builds.yml), [release boundary](https://github.com/anomalyco/hex/blob/2548a1b876c496cda30647cc1b0736cd4b9299c0/docs/releasing.md), and [agent policy](https://github.com/anomalyco/hex/blob/2548a1b876c496cda30647cc1b0736cd4b9299c0/.github/workflows/agent-policy.yml). We adopt small evidence-based PRs, downloadable development builds, and build/publish separation—not its private credentials, release service, or automatic-merge policy.

Useful next additions, once needed:

- Fill the feature-map index with source/test links and platform gaps; keep detail out of `AGENTS.md`.
- Run the existing fake-backed browser smoke checks in CI and retain screenshots for UI regressions.
- Add installer smoke checks and separate dev/stable app identities before signed releases or auto-updates.
- If an automated issue-to-PR agent is added, run its sensitive-path policy from the trusted base revision, not from the patch it is judging.
