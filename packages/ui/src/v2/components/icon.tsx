import { onMount, type ComponentProps, splitProps } from "solid-js"

const icons = {
  history: {
    viewBox: "0 0 20 20",
    body: `<path d="M3.2 5.8V2.8M3.2 5.8H6.2M3.3 5.6A7 7 0 1 1 3 13M10 6V10L13 11.8" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  "knowledge-check": {
    viewBox: "0 0 20 20",
    body: `<path d="M3 3.2V16.8M7 3.2V16.8M11 4V16M3 4H11M3 16H11M13 11.5L14.7 13.2L17.8 9.7" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  wiki: {
    viewBox: "0 0 20 20",
    body: `<path d="M2.5 3.2H7.7C9 3.2 10 4.2 10 5.5V16.8C10 15.5 9 14.5 7.7 14.5H2.5V3.2ZM17.5 3.2H12.3C11 3.2 10 4.2 10 5.5V16.8C10 15.5 11 14.5 12.3 14.5H17.5V3.2Z" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  package: {
    viewBox: "0 0 20 20",
    body: `<path d="M3 6L10 2.5L17 6V14L10 17.5L3 14V6ZM3 6L10 9.5L17 6M10 9.5V17.5M6.5 4.2L13.5 7.7" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  review: {
    viewBox: "0 0 20 20",
    body: `<path d="M2.5 2.5H17.5V17.5H2.5V2.5ZM5 7H8M6.5 5.5V8.5M11.5 7H15M5.2 12.2L7 14L10.5 10" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  "agent-tree": {
    viewBox: "0 0 20 20",
    body: `<circle cx="10" cy="4.5" r="2" stroke="currentColor"/><circle cx="5" cy="15.5" r="2" stroke="currentColor"/><circle cx="15" cy="15.5" r="2" stroke="currentColor"/><path d="M10 6.5V10M5 13.5V10H15V13.5" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  oversight: {
    viewBox: "0 0 20 20",
    body: `<path d="M10 2.2L17 4.5V9.9C17 13.9 13.5 16.1 10 17.9C6.5 16.1 3 13.9 3 9.9V4.5L10 2.2Z" stroke="currentColor" stroke-linejoin="round"/><path d="M5.7 9.9C5.7 9.9 7.4 7.6 10 7.6C12.6 7.6 14.3 9.9 14.3 9.9C14.3 9.9 12.6 12.2 10 12.2C7.4 12.2 5.7 9.9 5.7 9.9Z" stroke="currentColor" stroke-linejoin="round"/><circle cx="10" cy="9.9" r="1.2" stroke="currentColor"/>`,
  },
  debug: {
    viewBox: "0 0 20 20",
    body: `<path d="M7 6V4.8A3 3 0 0 1 13 4.8V6M5.5 7.5H14.5V12.7A4.5 4.5 0 0 1 5.5 12.7V7.5ZM10 7.5V17.2M3 9H5.5M14.5 9H17M3 13H5.5M14.5 13H17M5.5 6L4 4.5M14.5 6L16 4.5" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  profile: {
    viewBox: "0 0 20 20",
    body: `<path d="M3 15.5A7 7 0 0 1 17 15.5H3ZM10 15.5L13.7 10.5M5.5 12.8L4.2 12M14.5 12.8L15.8 12M10 8.5V7" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  intelligence: {
    viewBox: "0 0 20 20",
    body: `<path d="M10 3V17M10 5.5C8.7 3.3 4.6 3.4 4.5 6.7C1.8 7.5 1.9 11.5 4 12.5C3.8 15.5 7.3 17.3 10 15M10 5.5C11.3 3.3 15.4 3.4 15.5 6.7C18.2 7.5 18.1 11.5 16 12.5C16.2 15.5 12.7 17.3 10 15M6.5 9C8.1 9 10 7.5 10 5.5M13.5 11C11.9 11 10 12.5 10 14.5" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  experts: {
    viewBox: "0 0 20 20",
    body: `<circle cx="10" cy="5" r="2.2" stroke="currentColor"/><circle cx="4.8" cy="10.5" r="1.7" stroke="currentColor"/><circle cx="15.2" cy="10.5" r="1.7" stroke="currentColor"/><path d="M6.5 17C6.7 14.5 8 13 10 13C12 13 13.3 14.5 13.5 17M2.2 16C2.3 14.1 3.2 13 4.8 13C5.8 13 6.5 13.4 6.9 14.2M17.8 16C17.7 14.1 16.8 13 15.2 13C14.2 13 13.5 13.4 13.1 14.2" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  goal: {
    viewBox: "0 0 20 20",
    body: `<circle cx="10" cy="10" r="7.5" stroke="currentColor"/><circle cx="10" cy="10" r="4" stroke="currentColor"/><circle cx="10" cy="10" r="0.8" fill="currentColor"/>`,
  },
  edit: {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5555 8.21534V13.5556H2.44434L2.44434 2.4445H7.78462M6.88878 9.11119C6.88878 9.11119 8.96327 9.0367 9.69678 8.3032L14.0301 3.96986C14.5824 3.4176 14.5824 2.52213 14.0301 1.96986C13.4778 1.4176 12.5824 1.4176 12.0301 1.96986L7.69678 6.3032C7.00513 6.99484 6.88878 9.11119 6.88878 9.11119Z" stroke="currentColor"/>`,
  },
  "folder-add-left": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.5 13.3333H1.5V2H6.83333L8.83333 4H14.8333V6M10.1667 11.3333H15.5M12.8333 8.66667V14" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  "grid-plus": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.9948 11.668H9.32812M11.6641 9.33203V13.9987M6.66667 9.33203V13.9987H2V9.33203H6.66667ZM6.66667 2V6.66667H2V2H6.66667ZM13.9948 2V6.66667H9.32812V2H13.9948Z" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  help: {
    viewBox: "0 0 16 16",
    body: `<path d="M6.33345 6.33349V5.00015H9.66679V7.00015L8.00015 8.00015V9.66679M8.27485 11.6819H7.71897M14.4446 8.00011C14.4446 11.5593 11.5593 14.4446 8.00011 14.4446C4.44094 14.4446 1.55566 11.5593 1.55566 8.00011C1.55566 4.44094 4.44094 1.55566 8.00011 1.55566C11.5593 1.55566 14.4446 4.44094 14.4446 8.00011Z" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "sidebar-right": {
    viewBox: "0 0 20 20",
    body: `<path d="M2.91536 2.91406H2.36536V2.36406H2.91536V2.91406ZM2.91536 17.0807V17.6307H2.36536V17.0807H2.91536ZM17.082 17.0807H17.632V17.6307H17.082V17.0807ZM17.082 2.91406V2.36406H17.632V2.91406H17.082ZM6.9987 2.91406H6.4487V2.36406H6.9987V2.91406ZM6.9987 17.0807V17.6307H6.4487V17.0807H6.9987ZM2.91536 2.91406H3.46536V17.0807H2.91536H2.36536V2.91406H2.91536ZM2.91536 17.0807V16.5307H17.082V17.0807V17.6307H2.91536V17.0807ZM17.082 17.0807H16.532V2.91406H17.082H17.632V17.0807H17.082ZM17.082 2.91406V3.46406H2.91536V2.91406V2.36406H17.082V2.91406ZM6.9987 2.91406H7.5487V17.0807H6.9987H6.4487V2.91406H6.9987ZM17.082 17.0807L17.082 17.6307L6.9987 17.6307V17.0807V16.5307L17.082 16.5307L17.082 17.0807ZM6.9987 2.91406V2.36406H17.082V2.91406V3.46406H6.9987V2.91406Z" fill="currentColor"/>`,
  },
  status: {
    viewBox: "0 0 20 20",
    body: `<path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  "status-active": {
    viewBox: "0 0 20 20",
    body: `<path d="M18 2H2V10H18V2Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 18H18V10H2V18Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  server: {
    viewBox: "0 0 20 20",
    body: `<rect x="3.35547" y="1.92969" width="13.2857" height="16.1429" stroke="currentColor"/><rect x="3.35547" y="11.9297" width="13.2857" height="6.14286" stroke="currentColor"/><rect x="12.8555" y="14.2852" width="1.42857" height="1.42857" fill="currentColor"/><rect x="10" y="14.2852" width="1.42857" height="1.42857" fill="currentColor"/>`,
  },
  mcp: {
    viewBox: "0 0 20 20",
    body: `<path d="M0.972656 9.37176L9.5214 1.60019C10.7018 0.527151 12.6155 0.527151 13.7957 1.60019C14.9761 2.67321 14.9761 4.41295 13.7957 5.48599L7.3397 11.3552" stroke="currentColor" stroke-linecap="round"/><path d="M7.42871 11.2747L13.7957 5.48643C14.9761 4.41338 16.8898 4.41338 18.0702 5.48643L18.1147 5.52688C19.2951 6.59993 19.2951 8.33966 18.1147 9.4127L10.3831 16.4414C9.98966 16.7991 9.98966 17.379 10.3831 17.7366L11.9707 19.1799" stroke="currentColor" stroke-linecap="round"/><path d="M11.6587 3.54346L5.33619 9.29119C4.15584 10.3642 4.15584 12.1039 5.33619 13.177C6.51649 14.25 8.43019 14.25 9.61054 13.177L15.9331 7.42923" stroke="currentColor" stroke-linecap="round"/>`,
  },
  plugin: {
    viewBox: "0 0 20 20",
    body: `<path d="M2.91699 2.91699H8.33366V5.00033C8.33366 6.15092 9.2664 7.08366 10.417 7.08366C11.5676 7.08366 12.5003 6.15092 12.5003 5.00033V2.91699H17.0837V7.50033H15.0003C13.8497 7.50033 12.917 8.43307 12.917 9.58366C12.917 10.7343 13.8497 11.667 15.0003 11.667H17.0837V17.0837H11.667V15.0003C11.667 13.8497 10.7343 12.917 9.58366 12.917C8.43307 12.917 7.50033 13.8497 7.50033 15.0003V17.0837H2.91699V12.5003H5.00033C6.15092 12.5003 7.08366 11.5676 7.08366 10.417C7.08366 9.2664 6.15092 8.33366 5.00033 8.33366H2.91699V2.91699Z" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  "magnifying-glass": {
    viewBox: "0 0 16 16",
    body: `<path d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z" stroke="currentColor"/>`,
  },
  menu: {
    viewBox: "0 0 16 16",
    body: `<path d="M2 8H14M2 4.664H14M2 11.336H14" stroke="currentColor"/>`,
  },
  plus: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 2.88867V13.1109" stroke="currentColor" stroke-linejoin="round"/><path d="M2.88867 8H13.1109" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "settings-gear": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.99998 1.3335L14 4.66683V11.3335L7.99998 14.6668L2 11.3335V4.66683L7.99998 1.3335Z" stroke="currentColor"/><path d="M9.99998 8.00016C9.99998 9.10476 9.10458 10.0002 7.99998 10.0002C6.89538 10.0002 5.99998 9.10476 5.99998 8.00016C5.99998 6.89556 6.89538 6.00016 7.99998 6.00016C9.10458 6.00016 9.99998 6.89556 9.99998 8.00016Z" stroke="currentColor"/>`,
  },
  "chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  close: {
    viewBox: "0 0 20 20",
    body: `<path d="M14.4446 5.55566L5.55566 14.4446M5.55566 5.55566L14.4446 14.4446" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "xmark-small": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="currentColor"/>`,
  },
  "outline-chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  "outline-dots": {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor"/><path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor"/><path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor"/>`,
  },
}

const spriteID = "deepagent-code-v2-icon-sprite"
const symbol = (name: keyof typeof icons) => `deepagent-code-v2-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return

  // A hot update keeps the document alive, so replace the stale symbol set from the previous module.
  document.getElementById(spriteID)?.remove()
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = Object.entries(icons)
    .map(
      ([name, icon]) =>
        `<symbol id="${symbol(name as keyof typeof icons)}" viewBox="${icon.viewBox}">${icon.body}</symbol>`,
    )
    .join("")
  document.body.insertBefore(svg, document.body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons | (string & {})
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const [split, rest] = splitProps(props, ["name", "size"])
  const iconName = () => (icons[split.name as keyof typeof icons] ? (split.name as keyof typeof icons) : "plus")
  const icon = () => icons[iconName()]
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  onMount(ensureSprite)

  return (
    <svg
      {...rest}
      data-slot="icon-svg"
      width={pixelSize}
      height={pixelSize}
      viewBox={icon().viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <use href={`#${symbol(iconName())}`} />
    </svg>
  )
}
