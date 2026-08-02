export default function DesktopFluidOrb({ style = 'fluid' }) {
  const currentStyle = style || 'fluid';

  if (currentStyle === 'goo') {
    return (
      <div className="stage goo-orb">
        <div className="stage-scale goo-scale">
          <div className="goo">
            <div className="fill" />
            <div className="shade" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stage fluid-orb">
      <div className="stage-scale">
        <div className="fluid">
          <span className="blob b1" />
          <span className="blob b2" />
          <span className="blob b3" />
          <span className="blob b4" />
          <div className="glass" />
        </div>
      </div>
    </div>
  );
}
