// Tiny ANSI helper — no dependency. Off for non-TTY stdout or NO_COLOR (piped/CI output
// stays plain and diffable; https://no-color.org).
export const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR

const paint = (code: string) => (s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

export const dim = paint('2')
export const bold = paint('1')
export const cyan = paint('36')
export const yellow = paint('33')
export const red = paint('31')
export const green = paint('32')
export const magenta = paint('35')
