# Inactive chat cache size

Disabled by default. This exposes a missing size setting for Codex's existing
inactive owner cache. The default remains ten; configure
`settings.inactive-chat-cache.maximumInactiveOwners` to an integer from zero
to ten when enabling the feature. A small cache trades faster switching to
inactive chats for lower retained history and per-chat helper memory.

```json
{
  "enabled": ["inactive-chat-cache"],
  "settings": {"inactive-chat-cache": {"maximumInactiveOwners": 2}}
}
```

The transform changes the native cache count in the main companion and
webview bundles. It also repeats the existing activity/follower/keep-loaded
checks immediately before unsubscribe dispatch: an inactive candidate can
become visible or active before the scheduled unsubscribe executes. Native three-hour retention, retry behavior, active views,
stream followers, ownership, pending requests and resume behavior are retained.
It neither interrupts work nor kills helper processes. Backend disposal may
lag frontend unsubscription. Reducing the count is not proof of fixing a leak.

Bundle discovery uses the eviction method and initializer contract rather than
release-specific filenames or symbols. Missing, duplicated or changed contracts
abort the feature build before either bundle is modified. Signed executable
payloads remain unchanged. Remove the feature if upstream provides a supported
cache-size setting; no permanent divergence is intended or assumed accepted by
upstream maintainers.

Qualification: adjacent tests and current official bundle transformation are
required. Live history reload, pending requests, follower subscriptions and
actual memory release remain separate acceptance checks before installation.

For Nix, the package override accepts both `linuxFeatureIds` and
`linuxFeatureSettings`:

```nix
codex-desktop.override {
  linuxFeatureIds = [ "inactive-chat-cache" ];
  linuxFeatureSettings.inactive-chat-cache.maximumInactiveOwners = 2;
}
```
