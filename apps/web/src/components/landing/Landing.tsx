// The landing page (V14+ "Ledge"): one claim, one focal object driven by the live vote, then six sections,
// each with its own ground and shape. Data comes from one read of the selected network (LandingData).
import { BoardPreview } from "./BoardPreview";
import { BorrowBand } from "./BorrowBand";
import { BuiltOnMezo } from "./BuiltOnMezo";
import { Footer } from "./Footer";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import s from "./Landing.module.css";
import { LandingDataProvider } from "./LandingData";
import { Nav } from "./Nav";
import { ProofStrip } from "./ProofStrip";
import { Reveal } from "./Reveal";
import { Waterfall } from "./Waterfall";

export function Landing() {
  return (
    <div className={s.page}>
      <a href="#how" className="skip-link">
        Skip to content
      </a>
      <LandingDataProvider>
        <Nav />
        <Hero />
        <main>
          <HowItWorks />
          <Waterfall />
          <BorrowBand />
          <BoardPreview />
          <BuiltOnMezo />
          <ProofStrip />
        </main>
        <Footer />
        <Reveal />
      </LandingDataProvider>
    </div>
  );
}
