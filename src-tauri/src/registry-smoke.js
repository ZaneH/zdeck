// Embedded only by the opt-in native-smoke feature. No trust/enable/device calls.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const view = () => invoke('plugin_archive_view');
  const settled = async () => {
    for (let i = 0; i < 700; i++) {
      const state = await view();
      if (!state.busy) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Native review timed out');
  };
  try {
    let state = await settled();
    assert((await invoke('plugin_catalog')).plugins.length === 0, 'Smoke must start with no plugins');
    if (state.registry) {
      assert(!state.review && !state.registry.release, 'Link must not authorize an archive');
      await invoke('plugin_archive_resolve', { reviewId: state.registry.reviewId });
      state = await settled();
      if (EXPECTED_MISSING) {
        assert(state.error && !state.review && !state.registry.release, '404 must not authorize anything');
        await invoke('plugin_archive_cancel', { reviewId: state.registry.reviewId });
        assert((await invoke('plugin_catalog')).plugins.length === 0, '404 installed a plugin');
        window.__zdeckRegistrySmoke = { ok: true, mode: 'public-404', error: state.error };
        return;
      }
      assert(state.registry.release && !state.review && !state.error, 'Lookup must verify metadata only');
      await invoke('plugin_archive_resolve', { reviewId: state.registry.reviewId });
      state = await settled();
    }
    assert(!state.error && state.review?.id === 'EXPECTED_ID' && state.review.version === 'EXPECTED_VERSION', 'Exact candidate archive review missing');
    const review = state.review;
    assert(!review.collision, 'Unexpected existing plugin');
    await invoke('plugin_archive_install', { reviewId: review.reviewId });
    state = await settled();
    assert(!state.error && state.installedEpoch === 1, 'Native install failed');
    const catalog = await invoke('plugin_catalog');
    assert(catalog.plugins.length === 1 && !catalog.plugins[0].trusted, 'Installed package must remain untrusted');
    assert(Object.keys(await invoke('plugin_snapshots')).length === 0, 'Install started plugin execution');
    window.__zdeckRegistrySmoke = { ok: true, mode: 'disabled-install', review, catalog };
  } catch (error) {
    window.__zdeckRegistrySmoke = { ok: false, error: String(error) };
  }
})();
