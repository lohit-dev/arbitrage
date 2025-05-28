import { env } from "../config";

export class Logger {
  private logLevel: string;

  constructor() {
    this.logLevel = env.LOG_LEVEL;
  }

  private formatMessage(
    level: string,
    message: string,
    ...args: any[]
  ): string {
    const timestamp = new Date().toISOString();
    const formattedArgs =
      args.length > 0
        ? " " +
          args
            .map((arg) =>
              typeof arg === "object"
                ? JSON.stringify(arg, null, 2)
                : String(arg)
            )
            .join(" ")
        : "";

    // return `[${timestamp}] ${level}: ${message}${formattedArgs}`;
    return `${level}: ${message}${formattedArgs}`;
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog("info")) {
      console.log(this.formatMessage("INFO", message, ...args));
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog("error")) {
      console.error(this.formatMessage("ERROR", message, ...args));
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage("WARN", message, ...args));
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog("debug")) {
      console.log(this.formatMessage("DEBUG", message, ...args));
    }
  }
  private shouldLog(level: string): boolean {
    const levels = ["error", "warn", "info", "debug"];
    const currentLevelIndex = levels.indexOf(this.logLevel.toLowerCase());
    const incomingLevelIndex = levels.indexOf(level.toLowerCase());

    return incomingLevelIndex <= currentLevelIndex;
  }
}

export const logger = new Logger();
