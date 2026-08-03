import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import HomePage from '../app/page'

describe('HomePage', () => {
  it('renders a link to start the github oauth flow', () => {
    render(<HomePage />)
    const link = screen.getByRole('link', { name: /login with github/i })
    expect(link).toHaveAttribute('href', 'http://localhost:4000/auth/github')
  })
})
