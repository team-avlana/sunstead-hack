// Agency UGC dashboard — the operational pipeline surface for coaching UGC
// creators at scale (roster · deliveries queue · coaching notes · trends).
// A separate surface from the canvas (the solo-creator ideation product); both
// front the same analysis core. See docs/ugc-coaching-exploration.md.
import AgencyClient from '@/components/agency/AgencyClient'

export const metadata = {
  title: 'Rainey · Agency',
  description: 'Coach the part of the video no one can see — at scale.',
}

export default function Page() {
  return <AgencyClient />
}
