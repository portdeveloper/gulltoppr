-- Supabase schema for gulltoppr contract ABIs

CREATE TABLE IF NOT EXISTS contract_abis (
    id BIGSERIAL PRIMARY KEY,
    contract_address TEXT NOT NULL,
    rpc_url_hash TEXT NOT NULL,
    abi_json TEXT NOT NULL,
    bytecode_hash TEXT,
    decompilation_output TEXT, -- Store full heimdall output if needed
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure unique combination of contract + RPC
    UNIQUE(contract_address, rpc_url_hash)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_contract_lookup ON contract_abis(contract_address, rpc_url_hash);
CREATE INDEX IF NOT EXISTS idx_bytecode_dedup ON contract_abis(bytecode_hash);
CREATE INDEX IF NOT EXISTS idx_created_at ON contract_abis(created_at);

-- Optional: Enable Row Level Security (RLS)
ALTER TABLE contract_abis ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows all operations (adjust as needed)
-- Note: Drop the policy first if it exists, then create it
DROP POLICY IF EXISTS "Allow all operations" ON contract_abis;
CREATE POLICY "Allow all operations" ON contract_abis
    FOR ALL USING (true);