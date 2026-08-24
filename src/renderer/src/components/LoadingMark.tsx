export function LoadingMark({ label }: { label: string }) {
  const delays = [0, 120, 240]
  return (
    <span className="inline-flex items-center gap-2.5">
      <span aria-hidden className="grid grid-cols-3 gap-[1.5px]">
        {delays.map((delay) => (
          <span
            key={delay}
            className="size-[4px] rounded-[1px] bg-paper"
            style={{
              opacity: 0.15,
              animation: `pixel-on 900ms ease-in-out ${delay}ms infinite`
            }}
          />
        ))}
      </span>
      <span className="text-[13px] font-medium text-fog">{label}</span>
    </span>
  )
}
