// A simple throttle function
export function throttle(callback: () => void, delay: number) {
  let timeoutId: number | null = null;
  let lastExecution = 0;

  return () => {
    const now = Date.now();
    const elapsed = now - lastExecution;

    const execute = () => {
      lastExecution = now;
      callback();
    };

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (elapsed > delay) {
      execute();
    } else {
      timeoutId = window.setTimeout(execute, delay);
    }
  };
}
