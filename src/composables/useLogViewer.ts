import { shallowRef, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';

export interface LogEntry {
  seq: number;
  timestamp: string;
  level: string;
  target: string;
  message: string;
}

// Mirrors the backend's in-memory cap (app_log::MAX_LOG_ENTRIES).
const MAX_LOG_ENTRIES = 5000;

export function useLogViewer() {
  const logs = shallowRef<LogEntry[]>([]);
  let intervalId: number | null = null;
  let lastSeq: number | undefined;
  let fetching = false;

  // Only fetch entries newer than the last one we have; the backend keeps a
  // bounded buffer, so a full fetch every second would copy thousands of
  // entries across IPC for nothing.
  const fetchLogs = async () => {
    if (fetching) return;
    fetching = true;
    try {
      const entries = await invoke<LogEntry[]>('get_logs', { since: lastSeq });
      if (entries.length === 0) return;

      lastSeq = entries[entries.length - 1].seq;
      const merged = logs.value.concat(entries);
      logs.value =
        merged.length > MAX_LOG_ENTRIES
          ? merged.slice(merged.length - MAX_LOG_ENTRIES)
          : merged;
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      fetching = false;
    }
  };

  onMounted(() => {
    fetchLogs();
    intervalId = window.setInterval(fetchLogs, 1000);
  });

  onUnmounted(() => {
    if (intervalId !== null) {
      clearInterval(intervalId);
    }
  });

  return {
    logs,
  };
}
