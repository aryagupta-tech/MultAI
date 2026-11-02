// Polling that respects the phone: it pauses in the background, catches up on resume, backs off
// on errors and never overlaps itself.
import {useEffect, useRef, useState} from 'react';
import {ApiError, backoff} from '@multai/companion-core';

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {window.removeEventListener('online', update); window.removeEventListener('offline', update);};
  }, []);
  return online;
}

export interface PollState {failing: boolean; offline: boolean; lastOk: number | null}

/**
 * Runs `work` now and then every `interval` ms while the page is visible. Errors back off (and are
 * reported), the next run waits for the previous one, and `resumeSignal` changes trigger a run.
 */
export function usePoll(work: (signal: AbortSignal) => Promise<void>, interval: number, deps: readonly unknown[], resumeSignal = 0): PollState {
  const [state, setState] = useState<PollState>({failing: false, offline: false, lastOk: null});
  const latest = useRef(work);
  latest.current = work;
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    const controller = new AbortController();
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {schedule(interval); return;}
      running = true;
      try {
        await latest.current(controller.signal);
        failures = 0;
        if (!stopped) setState({failing: false, offline: false, lastOk: Date.now()});
      } catch (error) {
        if (stopped) return;
        failures++;
        setState(previous => ({...previous, failing: true, offline: error instanceof ApiError && error.offline}));
      } finally {running = false;}
      schedule(failures ? backoff(failures, interval, 30_000) : interval);
    };
    const schedule = (ms: number) => {if (!stopped) {clearTimeout(timer); timer = setTimeout(() => void run(), ms);}};
    const visible = () => {if (document.visibilityState === 'visible') {clearTimeout(timer); void run();}};
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    void run();
    return () => {stopped = true; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, interval, resumeSignal]);
  return state;
}

/** A stable id for one intended action: repeated taps and retries reuse it until the action changes. */
export function useRequestId(key: string): [string, () => void] {
  const ref = useRef<{key: string; id: string}>({key, id: crypto.randomUUID()});
  if (ref.current.key !== key) ref.current = {key, id: crypto.randomUUID()};
  return [ref.current.id, () => {ref.current = {key, id: crypto.randomUUID()};}];
}

export function useNow(interval = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer);}, [interval]);
  return now;
}
