export default function DesktopFluidOrb({ style = 'fluid' }) {
  if (style === 'goo') {
    return (
      <div className="stage goo-orb">
        <div className="stage-scale goo-scale">
          <div className="goo">
            <div className="fill"></div>
            <div className="shade"></div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="stage fluid-orb">
      <div className="stage-scale">
        <div className="fluid">
          <span className="blob b1"></span><span className="blob b2"></span>
          <span className="blob b3"></span><span className="blob b4"></span>
          <div className="glass"></div>
        </div>
      </div>
    </div>
  )
}
