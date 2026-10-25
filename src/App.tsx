import { useState } from "react";
import { VehicleScene, VEHICLES } from "./game/VehicleScene";

export default function App() {
  const [selected, setSelected] = useState(0);
  const vehicle = VEHICLES[selected];
  return <main>
    <header><a className="arcade" href="https://www.oleyarcade.com/">← OleyArcade</a><span className="edition">Garage preview</span></header>
    <section className="intro" aria-labelledby="title"><p className="eyebrow">The world is your arena</p><h1 id="title">WRECK<span>TERRA</span></h1><p className="lede">Take the scenic route.<br/>Leave a wreck.</p></section>
    <section className="garage" aria-label="Vehicle garage"><VehicleScene vehicle={vehicle} />
      <div className="vehicle-heading"><div><p className="eyebrow">Your ride</p><h2>{vehicle.name}</h2></div><p>{vehicle.role}</p></div>
      <div className="choices" role="group" aria-label="Choose a vehicle">{VEHICLES.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}><span>{item.name}</span><small>{item.role}</small></button>)}</div>
      <dl className="stats" aria-live="polite"><div><dt>Speed</dt><dd>{vehicle.speed} / 5</dd></div><div><dt>Armor</dt><dd>{vehicle.armor} / 5</dd></div><div><dt>First arena</dt><dd>Central Park</dd></div></dl>
    </section>
    <footer><strong>New York is up first.</strong><p>The driving prototype is in development. This garage lets you preview the original starter vehicles.</p></footer>
  </main>;
}
