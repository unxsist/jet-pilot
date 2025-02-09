import { ref, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export function useLogViewer() {
  const logs = ref<LogEntry[]>([]);
  let intervalId: number | null = null;

  const fetchLogs = async () => {
    try {
      logs.value = await invoke<LogEntry[]>('get_logs');
    } catch (error) {
      console.error('Failed to fetch logs:', error);
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
