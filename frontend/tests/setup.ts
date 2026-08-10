import '@testing-library/jest-dom/vitest'
import { vi, beforeEach } from 'vitest'

beforeEach(() => {
  // Create a mock location object with a configurable reload method
  const mockLocation = {
    ...window.location,
    reload: vi.fn(),
  }
  vi.stubGlobal('location', mockLocation)
})
