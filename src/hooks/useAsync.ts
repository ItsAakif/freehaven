import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncState<T> = {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
  refresh: () => void;
  setData: (value: T) => void;
};

/**
 * Tiny async resource hook with mount-safety and a manual refresh.
 * Local SQLite reads are fast enough that a cache layer would add complexity
 * without benefit; screens re-read on focus where it matters.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const value = await fnRef.current();
      if (mounted.current) {
        setData(value);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message ?? 'Something went wrong.');
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    // Deferred by a task so the first paint is not blocked by a synchronous
    // loading-state update inside the effect.
    const timer = setTimeout(() => {
      void run(false);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    data,
    error,
    loading,
    refreshing,
    reload: () => void run(false),
    refresh: () => void run(true),
    setData,
  };
}
