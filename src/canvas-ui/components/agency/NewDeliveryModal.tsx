'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './agency.module.css'
import { createDelivery, fetchRoster, fileToDataUrl, type RosterRow } from '@/lib/agency'

type Tab = 'upload' | 'url'

export default function NewDeliveryModal({
  defaultCreatorId,
  onClose,
  onCreated,
}: {
  defaultCreatorId?: string
  onClose: () => void
  onCreated: (reviewId: string) => void
}) {
  const [creators, setCreators] = useState<RosterRow[]>([])
  const [creatorId, setCreatorId] = useState(defaultCreatorId ?? '')
  const [newName, setNewName] = useState('')
  const [tab, setTab] = useState<Tab>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [briefTitle, setBriefTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchRoster().then(setCreators)
  }, [])

  const ADD_NEW = '__new__'
  const creatorMode = creatorId === ADD_NEW || (!creatorId && creators.length === 0)

  const submit = async () => {
    setErr(null)
    // Validate creator.
    let payloadCreator: { creator_id?: string; creator_name?: string }
    if (creatorMode) {
      if (!newName.trim()) return setErr('Enter a creator name.')
      payloadCreator = { creator_name: newName.trim() }
    } else if (creatorId) {
      payloadCreator = { creator_id: creatorId }
    } else {
      return setErr('Pick a creator.')
    }
    // Validate source.
    if (tab === 'upload' && !file) return setErr('Choose a video file to upload.')
    if (tab === 'url' && !sourceUrl.trim()) return setErr('Paste the delivery video URL.')

    setBusy(true)
    try {
      const body: Parameters<typeof createDelivery>[0] = {
        ...payloadCreator,
        brief_title: briefTitle.trim() || undefined,
        brief: brief.trim() || undefined,
        reference_url: referenceUrl.trim() || undefined,
      }
      if (tab === 'upload' && file) {
        body.file_name = file.name
        body.file_data = await fileToDataUrl(file)
      } else {
        body.source_url = sourceUrl.trim()
      }
      const res = await createDelivery(body)
      if (!res) {
        setErr('Could not start the review. Is the backend running?')
        setBusy(false)
        return
      }
      onCreated(res.review_id)
    } catch {
      setErr('Could not start the review.')
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <span className={styles.modalTitle}>New review</span>
          <button className={`${styles.btn} ${styles.btnGhost} ${styles.btnSm}`} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className={styles.modalBody}>
          {/* creator */}
          <div className={styles.field}>
            <label className={styles.label}>Creator</label>
            {creators.length > 0 && (
              <select
                className={styles.select}
                value={creatorId}
                onChange={(e) => setCreatorId(e.target.value)}
              >
                <option value="">Select a creator…</option>
                {creators.map((c) => (
                  <option key={c.creator_id} value={c.creator_id}>
                    {c.name}
                  </option>
                ))}
                <option value={ADD_NEW}>+ New creator…</option>
              </select>
            )}
            {creatorMode && (
              <input
                className={styles.input}
                placeholder="New creator name (e.g. Maya R.)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={{ marginTop: creators.length > 0 ? 8 : 0 }}
              />
            )}
          </div>

          {/* source */}
          <div className={styles.field}>
            <label className={styles.label}>Delivery video</label>
            <div className={styles.segmented} style={{ alignSelf: 'flex-start' }}>
              <button
                className={`${styles.segBtn} ${tab === 'upload' ? styles.segBtnActive : ''}`}
                onClick={() => setTab('upload')}
              >
                Upload file
              </button>
              <button
                className={`${styles.segBtn} ${tab === 'url' ? styles.segBtnActive : ''}`}
                onClick={() => setTab('url')}
              >
                Paste URL
              </button>
            </div>
            {tab === 'upload' ? (
              <>
                <div className={styles.drop} onClick={() => fileInput.current?.click()}>
                  {file ? (
                    <span className={styles.dropFile}>{file.name}</span>
                  ) : (
                    <span className={styles.hint}>Click to choose a video file (mp4, mov…)</span>
                  )}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="video/*"
                  hidden
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <span className={styles.hint}>
                  Upload is most reliable — the agency already has the file (sidesteps TikTok/IG login
                  walls).
                </span>
              </>
            ) : (
              <input
                className={styles.input}
                placeholder="https://… (YouTube reliable; TikTok/IG best-effort)"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
              />
            )}
          </div>

          {/* brief */}
          <div className={styles.field}>
            <label className={styles.label}>
              Brief <span className={styles.hint}>(optional)</span>
            </label>
            <input
              className={styles.input}
              placeholder="Brief title (e.g. Skincare hook test)"
              value={briefTitle}
              onChange={(e) => setBriefTitle(e.target.value)}
            />
            <textarea
              className={styles.textarea}
              placeholder="What was the creator asked to make? Hook, tone, must-says, on-screen text, CTA…"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              style={{ marginTop: 8 }}
            />
          </div>

          {/* reference */}
          <div className={styles.field}>
            <label className={styles.label}>
              Reference video URL <span className={styles.hint}>(optional — the style to match)</span>
            </label>
            <input
              className={styles.input}
              placeholder="https://… a reference / winning video"
              value={referenceUrl}
              onChange={(e) => setReferenceUrl(e.target.value)}
            />
          </div>

          {err && <div className={styles.modalErr}>{err}</div>}
        </div>

        <div className={styles.modalFoot}>
          <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={submit} disabled={busy}>
            {busy ? 'Starting…' : 'Start review'}
          </button>
        </div>
      </div>
    </div>
  )
}
