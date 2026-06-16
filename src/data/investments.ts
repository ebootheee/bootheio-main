// Generated from prod EmDash 'investments' collection during the Astro migration.
// Edit freely — this is now the source of truth for the /about portfolio grid.
export interface Investment {
  name: string;
  url: string;
  logo: string;
  tagline: string;
  pitch: string;
  industry: string;
  sort_order: number;
  co_investors?: string;
  acquired_by?: string;
}

export const investments: Investment[] = [
  {
    "name": "Roebling",
    "url": "https://roebling.com/",
    "logo": "/portfolio/roebling.png",
    "tagline": "AI-native capital project planning.",
    "pitch": "Techno-economic modeling that fuses process design, equipment sizing, cost estimation, and project economics. Feasibility studies in days instead of months.",
    "industry": "industrial software",
    "sort_order": 1,
    "co_investors": "Giant Ventures, a16z"
  },
  {
    "name": "Shackleton",
    "url": "https://www.shackleton.ai/",
    "logo": "/portfolio/shackleton.svg",
    "tagline": "The agentic OS for development and construction.",
    "pitch": "Specialized agents that handle project planning, RFI processing, bid management, and financial tracking across the construction lifecycle. Less spreadsheet drag, more project visibility - for GCs, owners, and franchise operators.",
    "industry": "construction tech",
    "sort_order": 2,
    "co_investors": ""
  },
  {
    "name": "Flipturn",
    "url": "https://www.getflipturn.com/",
    "logo": "/portfolio/flipturn.jpg",
    "tagline": "Modern charging software, built for how you charge.",
    "pitch": "EV charging management for fleets, multifamily, and commercial sites — monitoring, energy management, billing, and an AI ops agent watching the network 24/7.",
    "industry": "EV charging",
    "sort_order": 3,
    "co_investors": "CRV, Accel, Comma Capital, Background Capital"
  },
  {
    "name": "Power Neutron",
    "url": "https://www.powerneutron.com/",
    "logo": "/portfolio/powerneutron.png",
    "tagline": "Battery-powered savings. Zero upfront cost.",
    "pitch": "Zero-capex battery storage for hospitality properties. Up to 20% lower energy bills, immediate NOI lift, backup power included — they handle install and optimization.",
    "industry": "energy storage",
    "sort_order": 4
  },
  {
    "name": "Mason",
    "url": "https://usemason.ai/",
    "logo": "/portfolio/mason.png",
    "tagline": "An autonomous AI workforce for real estate development.",
    "pitch": "Pulls project data, zoning, market insights, and third-party systems into one workspace; ships audit-ready outputs in the formats developers actually use (Excel, PDF).",
    "industry": "real estate tech",
    "sort_order": 5,
    "co_investors": "Wischoff Ventures"
  },
  {
    "name": "Beam",
    "url": "https://www.trybeam.com/",
    "logo": "/portfolio/beam.png",
    "tagline": "Estimating, project management, and payments for contractors.",
    "pitch": "AI-assisted estimating plus invoicing, job costing, expense tracking, and compliance. Built for residential and commercial contractors who'd otherwise live in spreadsheets.",
    "industry": "contech fintech",
    "sort_order": 6,
    "co_investors": "Zigg Capital, Accel, Teamworthy, RXR",
    "acquired_by": "CompanyCam"
  },
  {
    "name": "Stake",
    "url": "https://getyourstake.com/",
    "logo": "/portfolio/stake.png",
    "tagline": "The cash back network for renters.",
    "pitch": "Earn cash back on rent, build credit through on-time payments, get banking and rewards stacked on top. Aligns landlord, renter, and merchant incentives around the rent check.",
    "industry": "fintech / proptech",
    "sort_order": 7,
    "co_investors": "RET Ventures, Shadow Ventures, Hometeam.vc, Olive Tree Ventures, Bluefield Capital"
  }
];
