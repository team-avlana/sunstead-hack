import { useEffect, useLayoutEffect } from 'react'

/** useLayoutEffect on the client, useEffect on the server (avoids the SSR warning). */
export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect
