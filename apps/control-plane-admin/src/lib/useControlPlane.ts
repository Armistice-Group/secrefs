"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { ControlPlaneConfig } from "./types";

/** Small fetch-on-mount hook with an explicit `reload`. Deliberately not
 * a data library: the console makes a handful of requests per screen and
 * always wants to refetch after a mutation, so a cache would be state to
 * invalidate rather than state saved. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    run()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run]);

  useEffect(() => reload(), [reload]);

  return { data, error, loading, reload };
}

let configPromise: Promise<ControlPlaneConfig> | undefined;

/** The control plane's auth mode, fetched once per page load and shared -
 * every screen's chrome depends on it, and it can't change under a
 * running console. */
export function useControlPlaneConfig() {
  const [config, setConfig] = useState<ControlPlaneConfig | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    configPromise ??= api.getConfig();
    let cancelled = false;
    configPromise
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch((err: unknown) => {
        // Let the next mount retry rather than caching a failure forever.
        configPromise = undefined;
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, error };
}
