import chalk from 'chalk';

type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
}

class Logger {
  private debugEnabled = false;
  private silentMode = false;
  private readonly history: LogEntry[] = [];

  enableDebug(): void {
    this.debugEnabled = true;
  }

  enableSilent(): void {
    this.silentMode = true;
  }

  disableSilent(): void {
    this.silentMode = false;
  }

  isDebugEnabled(): boolean {
    return this.debugEnabled;
  }

  isSilent(): boolean {
    return this.silentMode;
  }

  /**
   * Log an informational message (blue dot prefix).
   */
  info(message: string): void {
    this.record('info', message);
    if (this.silentMode) return;
    console.log(chalk.blue('ℹ'), message);
  }

  /**
   * Log a success message (green checkmark prefix).
   */
  success(message: string): void {
    this.record('success', message);
    if (this.silentMode) return;
    console.log(chalk.green('✔'), message);
  }

  /**
   * Log a warning message (yellow warning prefix).
   */
  warn(message: string): void {
    this.record('warn', message);
    if (this.silentMode) return;
    console.warn(chalk.yellow('⚠'), message);
  }

  /**
   * Log an error message (red cross prefix). Always prints, even in silent mode.
   */
  error(message: string): void {
    this.record('error', message);
    console.error(chalk.red('✖'), message);
  }

  /**
   * Log a debug message (gray prefix). Only prints when debug mode is enabled.
   */
  debug(message: string): void {
    this.record('debug', message);
    if (this.silentMode || !this.debugEnabled) return;
    console.log(chalk.gray('[debug]'), message);
  }

  /**
   * Print a blank separator line (respects silent mode).
   */
  blank(): void {
    if (this.silentMode) return;
    console.log();
  }

  /**
   * Print a section header underlined in bold (respects silent mode).
   */
  section(title: string): void {
    if (this.silentMode) return;
    console.log();
    console.log(chalk.bold.underline(title));
  }

  /**
   * Print a plain line without any prefix (respects silent mode).
   */
  print(message: string): void {
    if (this.silentMode) return;
    console.log(message);
  }

  /**
   * Return a copy of the internal log history (useful for report generation).
   */
  getHistory(): readonly LogEntry[] {
    return [...this.history];
  }

  /**
   * Clear the log history.
   */
  clearHistory(): void {
    this.history.length = 0;
  }

  private record(level: LogLevel, message: string): void {
    this.history.push({ level, message, timestamp: new Date() });
  }
}

export const logger = new Logger();
