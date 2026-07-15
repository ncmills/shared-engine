import { runBookingRailContract } from "../concierge/rail-contract";
import { MockRail } from "../concierge/mock-rail";

runBookingRailContract("MockRail", () => new MockRail());
