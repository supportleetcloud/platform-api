'use client'

import { useState } from 'react'

export type ChallengeCheckFormRow = {
  name: string
  method: string
  path: string
  requestHeaders: string
  requestBody: string
  expectStatus: string
  expectJson: string
  expectHeaders: string
  points: string
}

export type ChallengeFormValues = {
  title: string
  description: string
  objective: string
  technicalDetails: string
  category: string
  checks: ChallengeCheckFormRow[]
}

export type ChallengeInput = {
  title: string
  description?: string
  objective?: string
  technicalDetails?: string
  category: string
  checks: {
    name: string
    method: string
    path: string
    requestHeaders?: Record<string, string>
    requestBody?: unknown
    expectStatus: number
    expectJson?: unknown
    expectHeaders?: Record<string, string>
    points: number
  }[]
}

const CATEGORIES = ['crud', 'contract', 'status', 'auth']
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'QUERY']

function emptyCheck(): ChallengeCheckFormRow {
  return {
    name: '',
    method: 'GET',
    path: '',
    requestHeaders: '',
    requestBody: '',
    expectStatus: '200',
    expectJson: '',
    expectHeaders: '',
    points: '10',
  }
}

type ParsedField = { ok: true; value: unknown } | { ok: false; error: string }

function parseOptionalJson(text: string, fieldLabel: string, rowIndex: number): ParsedField {
  if (text.trim().length === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: `Request type ${rowIndex + 1}: ${fieldLabel} is not valid JSON` }
  }
}

type ChallengeFormProps = {
  initial?: ChallengeFormValues
  onSave: (input: ChallengeInput) => Promise<{ ok: true } | { ok: false; error: string }>
}

export default function ChallengeForm({ initial, onSave }: ChallengeFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [objective, setObjective] = useState(initial?.objective ?? '')
  const [technicalDetails, setTechnicalDetails] = useState(initial?.technicalDetails ?? '')
  const [category, setCategory] = useState(initial?.category ?? CATEGORIES[0])
  const [checks, setChecks] = useState<ChallengeCheckFormRow[]>(initial?.checks ?? [emptyCheck()])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  function updateCheck(index: number, patch: Partial<ChallengeCheckFormRow>) {
    setChecks((prev) => prev.map((check, i) => (i === index ? { ...check, ...patch } : check)))
  }

  function addCheck() {
    setChecks((prev) => [...prev, emptyCheck()])
  }

  function removeCheck(index: number) {
    setChecks((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    const parsedChecks: ChallengeInput['checks'] = []
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i]
      const requestHeaders = parseOptionalJson(check.requestHeaders, 'request headers', i)
      if (!requestHeaders.ok) {
        setFormError(requestHeaders.error)
        return
      }
      const requestBody = parseOptionalJson(check.requestBody, 'request body', i)
      if (!requestBody.ok) {
        setFormError(requestBody.error)
        return
      }
      const expectJson = parseOptionalJson(check.expectJson, 'expected response JSON', i)
      if (!expectJson.ok) {
        setFormError(expectJson.error)
        return
      }
      const expectHeaders = parseOptionalJson(check.expectHeaders, 'expected headers', i)
      if (!expectHeaders.ok) {
        setFormError(expectHeaders.error)
        return
      }

      const expectStatus = Number(check.expectStatus)
      if (!Number.isInteger(expectStatus)) {
        setFormError(`Request type ${i + 1}: expected status must be a whole number`)
        return
      }
      const points = Number(check.points)
      if (!Number.isInteger(points) || points <= 0) {
        setFormError(`Request type ${i + 1}: points must be a positive whole number`)
        return
      }

      parsedChecks.push({
        name: check.name,
        method: check.method,
        path: check.path,
        requestHeaders: requestHeaders.value as Record<string, string> | undefined,
        requestBody: requestBody.value,
        expectStatus,
        expectJson: expectJson.value,
        expectHeaders: expectHeaders.value as Record<string, string> | undefined,
        points,
      })
    }

    setSaving(true)
    onSave({
      title,
      description: description.trim() || undefined,
      objective: objective.trim() || undefined,
      technicalDetails: technicalDetails.trim() || undefined,
      category,
      checks: parsedChecks,
    }).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setFormError(result.error)
      }
    })
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="title">
          Title
        </label>
        <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="description">
          Description
        </label>
        <textarea id="description" value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="objective">
          Objective
        </label>
        <textarea id="objective" value={objective} onChange={(event) => setObjective(event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="technicalDetails">
          Technical details
        </label>
        <textarea
          id="technicalDetails"
          value={technicalDetails}
          onChange={(event) => setTechnicalDetails(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="category">
          Category
        </label>
        <select id="category" value={category} onChange={(event) => setCategory(event.target.value)}>
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div>
        <p className="section-label">Request types</p>
        {checks.map((check, index) => (
          <div className="panel" key={index}>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-name`}>
                Name
              </label>
              <input
                id={`check-${index}-name`}
                value={check.name}
                onChange={(event) => updateCheck(index, { name: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-method`}>
                Method
              </label>
              <select
                id={`check-${index}-method`}
                value={check.method}
                onChange={(event) => updateCheck(index, { method: event.target.value })}
              >
                {METHODS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-path`}>
                Path
              </label>
              <input
                id={`check-${index}-path`}
                value={check.path}
                onChange={(event) => updateCheck(index, { path: event.target.value })}
                placeholder="/todos"
                required
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-requestHeaders`}>
                Request headers (JSON, optional)
              </label>
              <textarea
                id={`check-${index}-requestHeaders`}
                value={check.requestHeaders}
                onChange={(event) => updateCheck(index, { requestHeaders: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-requestBody`}>
                Request body (JSON, optional)
              </label>
              <textarea
                id={`check-${index}-requestBody`}
                value={check.requestBody}
                onChange={(event) => updateCheck(index, { requestBody: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-expectStatus`}>
                Expected status
              </label>
              <input
                id={`check-${index}-expectStatus`}
                type="number"
                value={check.expectStatus}
                onChange={(event) => updateCheck(index, { expectStatus: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-expectJson`}>
                Expected response JSON (optional)
              </label>
              <textarea
                id={`check-${index}-expectJson`}
                value={check.expectJson}
                onChange={(event) => updateCheck(index, { expectJson: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-expectHeaders`}>
                Expected headers (JSON, optional)
              </label>
              <textarea
                id={`check-${index}-expectHeaders`}
                value={check.expectHeaders}
                onChange={(event) => updateCheck(index, { expectHeaders: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-points`}>
                Points
              </label>
              <input
                id={`check-${index}-points`}
                type="number"
                value={check.points}
                onChange={(event) => updateCheck(index, { points: event.target.value })}
                required
              />
            </div>
            {checks.length > 1 && (
              <button type="button" onClick={() => removeCheck(index)}>
                Remove request type
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={addCheck}>
          Add request type
        </button>
      </div>

      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {formError && <p className="form-error">{formError}</p>}
    </form>
  )
}
