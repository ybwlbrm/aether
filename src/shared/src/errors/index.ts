/** 应用错误码 */
export enum ErrorCode {
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  AI_ERROR = 'AI_ERROR',
  TOOL_ERROR = 'TOOL_ERROR',
  FILE_ERROR = 'FILE_ERROR',
  PERMISSION_ERROR = 'PERMISSION_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/** 应用错误类 */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(entity: string, id: string): AppError {
    return new AppError(ErrorCode.NOT_FOUND, `${entity} ${id} 未找到`, 404);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, 400, details);
  }

  static permission(message: string): AppError {
    return new AppError(ErrorCode.PERMISSION_ERROR, message, 403);
  }

  static internal(message: string, details?: unknown): AppError {
    return new AppError(ErrorCode.INTERNAL_ERROR, message, 500, details);
  }
}