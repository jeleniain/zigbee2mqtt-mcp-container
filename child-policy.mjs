// Both retained-session and per-request gateway paths use spawnCommand.
// The fixed launcher execs its shell into Node, so each tracked process is
// one application child, not a shell that can exit while its child survives.
export function createChildLimiter(limit = 4) {
  let active = 0;
  return (spawn, ...args) => {
    if (active >= limit) throw new Error('Gateway child capacity reached');
    active++;
    let released = false;
    const release = () => {
      if (!released) { released = true; active--; }
    };
    try {
      const child = spawn(...args);
      child.once('exit', release);
      child.once('error', release);
      return child;
    } catch (error) {
      release();
      throw error;
    }
  };
}

export const boundedSpawn = createChildLimiter();
