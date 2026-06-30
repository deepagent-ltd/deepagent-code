import { createUniqueId, type ComponentProps } from "solid-js"
import { PixelWordmark } from "./pixel-wordmark"

export const Mark = (props: { class?: string }) => {
  const gradientID = createUniqueId()

  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="128 96 256 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientID} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="var(--logo-gradient-start)" />
          <stop offset="0.5" stop-color="var(--logo-gradient-mid)" />
          <stop offset="1" stop-color="var(--logo-gradient-end)" />
        </linearGradient>
      </defs>
      <line
        x1="176"
        y1="120"
        x2="176"
        y2="392"
        stroke="var(--logo-left-stroke)"
        stroke-width="44"
        stroke-linecap="butt"
      />
      <path
        d="M238 142 H336 V370 H238"
        stroke={`url(#${gradientID})`}
        stroke-width="44"
        stroke-linecap="square"
        stroke-linejoin="miter"
        fill="none"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  const gradientID = createUniqueId()

  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="128 96 256 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientID} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="var(--logo-gradient-start)" />
          <stop offset="0.5" stop-color="var(--logo-gradient-mid)" />
          <stop offset="1" stop-color="var(--logo-gradient-end)" />
        </linearGradient>
      </defs>
      <line
        x1="176"
        y1="120"
        x2="176"
        y2="392"
        stroke="var(--logo-left-stroke)"
        stroke-width="44"
        stroke-linecap="butt"
      />
      <path
        d="M238 142 H336 V370 H238"
        stroke={`url(#${gradientID})`}
        stroke-width="44"
        stroke-linecap="square"
        stroke-linejoin="miter"
        fill="none"
      />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return <PixelWordmark class={props.class} />
}
