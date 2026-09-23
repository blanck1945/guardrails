import { describe, it, expect } from 'vitest'
import { commentableLines } from './diff'

describe('commentableLines', () => {
  it('should identify commentable lines in a simple patch with context, additions, and deletions', () => {
    const patch = `@@ -10,5 +10,7 @@
 context line
-deleted line
+added line
 context line
 context line`

    const result = commentableLines(patch)

    // Line 10 (context) - commentable
    expect(result.has(10)).toBe(true)
    // Line 11 (added) - commentable
    expect(result.has(11)).toBe(true)
    // Line 12 (context) - commentable
    expect(result.has(12)).toBe(true)
    // Line 13 (context) - commentable
    expect(result.has(13)).toBe(true)

    // The deleted line is not added to the result set
    expect(result.size).toBe(4)
  })
})
