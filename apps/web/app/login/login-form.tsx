'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { loginFailureMessage } from './login-error'

export function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<'idle' | 'submitting'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('submitting')
    setMessage(null)
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) {
        setMessage(loginFailureMessage(response.status, response.headers.get('retry-after')))
        return
      }
      setPassword('')
      router.replace('/')
      router.refresh()
    } catch {
      setMessage('Musearr could not reach the local service. Try again shortly.')
    } finally {
      setState('idle')
    }
  }

  return (
    <form className="login-form" onSubmit={signIn}>
      <label>
        Local owner name
        <input
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
          required
          value={username}
        />
      </label>
      <label>
        Password
        <input
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </label>
      <button className="primary-button" disabled={state === 'submitting'} type="submit">
        {state === 'submitting' ? 'Signing in…' : 'Sign in'}
      </button>
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
    </form>
  )
}
