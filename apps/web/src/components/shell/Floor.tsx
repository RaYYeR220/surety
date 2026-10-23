import styles from "./Shell.module.css";

/** Page background: colour pools, the 48px grid and grain. All values come from theme tokens. */
export function Floor() {
  return (
    <>
      <div className={styles.floor} aria-hidden="true" />
      <div className={styles.grid} aria-hidden="true" />
      <div className={styles.grain} aria-hidden="true" />
    </>
  );
}
