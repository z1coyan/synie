export class AppError extends Error {
  readonly codes: string[]

  constructor(message: string, codes: string[], options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppError'
    this.codes = codes
  }
}

export const isForbidden = (error: unknown): boolean =>
  error instanceof AppError && error.codes.includes('forbidden')
