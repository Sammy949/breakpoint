import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// Step-3 bring-up: render a card and prove every gesture we rely on reaches
// the app. The card text is a static placeholder until the relay pushes
// real requests.
const CARD = [
  'demo · DESTRUCTIVE            (placeholder)',
  'git push --force origin main',
  'Rewrites remote history on main.',
  'APPROVE: swipe up, then tap',
  'DENY: swipe down',
].join('\n')

const bridge = await waitForEvenAppBridge()

const main = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: CARD,
  isEventCapture: 1,
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
)
console.log('breakpoint: page created', result === 0 ? 'ok' : `failed (${result})`)

// CLICK_EVENT is 0 and protobuf drops zero fields, so a tap arrives with
// eventType undefined. Resolve the default only when the envelope exists.
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const NAMES: Partial<Record<OsEventTypeList, string>> = {
  [OsEventTypeList.CLICK_EVENT]: 'tap',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: 'double tap',
  [OsEventTypeList.SCROLL_TOP_EVENT]: 'swipe up',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: 'swipe down',
  [OsEventTypeList.LONG_PRESS_EVENT]: 'long press',
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT]: 'long press release',
}

bridge.onEvenHubEvent(event => {
  const sys = typeOf(event.sysEvent)
  const text = typeOf(event.textEvent)
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return
  const type = text ?? sys
  if (type === null) return
  const name = NAMES[type] ?? `event ${type}`
  console.log('breakpoint: input', name, text !== null ? '(textEvent)' : '(sysEvent)')
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: `${CARD}\nlast input: ${name}` }),
  )
})
