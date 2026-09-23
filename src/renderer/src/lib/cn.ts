import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The @theme in index.css defines named type roles, radii, shadows and control
// metrics. Unregistered, tailwind-merge reads `text-label` as a colour and drops
// it beside `text-fog`, so the element silently falls back to 16px.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['title', 'body', 'label', 'meta'],
      radius: ['control', 'surface', 'track'],
      shadow: ['row', 'popover', 'dialog', 'ring'],
      spacing: ['control', 'field']
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
