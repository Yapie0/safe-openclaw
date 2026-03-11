/**
 * Password strength policy for safe-openclaw.
 * Requirements: 8+ chars, at least one uppercase, one lowercase, one digit.
 */

export type PasswordValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export function validateStrongPassword(password: string): PasswordValidationResult {
  if (!password || password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters long" };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: "Password must contain at least one uppercase letter" };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: "Password must contain at least one lowercase letter" };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: "Password must contain at least one digit" };
  }
  return { valid: true };
}
