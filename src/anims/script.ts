/**
 * The read-only Luau script of the animation pass (plans/36 "The clips"; Open Cloud Luau Execution, binary output, the
 * same task kind as the map export). For each animation id: `KeyframeSequenceProvider:GetKeyframeSequenceAsync(
 * "rbxassetid://<id>")` in a pcall, then every Keyframe's Poses (nested: Pose:GetSubPoses()) with their CFrame (as a
 * quaternion and a position), easing and weight, packed as format.ts `TTAN`. It changes nothing in the place.
 *
 * Loads run WORKERS at a time; past the deadline the rest are written as skipped (the next pass takes them).
 */
import { luauString } from "../maps/script.ts";

/** Ids per task at most (each load is a web call inside the task; a few hundred ms each). */
export const IDS_PER_TASK = 300;
export const WORKERS = 8;
/** Seconds of loading before the rest is skipped (the task's own timeout is longer). */
export const LOAD_SECONDS = 120;

/**
 * Roblox's default R6 animations (the default R6 `Animate` script's StringValues), so a fresh game has them without a
 * replay having logged them. From memory of that script (not read from a place): idle 180435571 and 180435792, walk
 * 180426354 (run uses the same id), jump 125750702, fall 180436148, climb 180436334, sit 178130996, toolnone 182393478.
 * The animation pass reports which load; one that fails just stays missing.
 */
export const DEFAULT_R6_ANIMATIONS: Readonly<Record<string, string>> = {
	"180435571": "idle",
	"180435792": "idle (look around)",
	"180426354": "walk / run",
	"125750702": "jump",
	"180436148": "fall",
	"180436334": "climb",
	"178130996": "sit",
	"182393478": "toolnone",
};

export function animScript(ids: readonly string[], options: { loadSeconds?: number; workers?: number } = {}): string {
	const list = ids.filter((id) => /^[1-9][0-9]{0,19}$/.test(id)).slice(0, IDS_PER_TASK);
	return `-- TypeTorch animation export (read-only: loads KeyframeSequences, returns a buffer). Format: backend src/anims/format.ts.
local HttpService = game:GetService("HttpService")
local KSP = game:GetService("KeyframeSequenceProvider")
local t0 = os.clock()
local IDS = { ${list.map((id) => luauString(id)).join(", ")} }
local DEADLINE = t0 + ${Math.max(5, Math.floor(options.loadSeconds ?? LOAD_SECONDS))}
local WORKERS = ${Math.max(1, Math.floor(options.workers ?? WORKERS))}
local MAX_FRAMES = 5000
local MAX_POSES = 128

local function quat(cf)
	local _, _, _, R00, R01, R02, R10, R11, R12, R20, R21, R22 = cf:GetComponents()
	local tr = R00 + R11 + R22
	if tr > 0 then
		local s = math.sqrt(tr + 1) * 2
		return (R21 - R12) / s, (R02 - R20) / s, (R10 - R01) / s, 0.25 * s
	elseif R00 > R11 and R00 > R22 then
		local s = math.sqrt(1 + R00 - R11 - R22) * 2
		return 0.25 * s, (R01 + R10) / s, (R02 + R20) / s, (R21 - R12) / s
	elseif R11 > R22 then
		local s = math.sqrt(1 + R11 - R00 - R22) * 2
		return (R01 + R10) / s, 0.25 * s, (R12 + R21) / s, (R02 - R20) / s
	else
		local s = math.sqrt(1 + R22 - R00 - R11) * 2
		return (R02 + R20) / s, (R12 + R21) / s, 0.25 * s, (R10 - R01) / s
	end
end

local function cut(s, n)
	if #s <= n then return s end
	return string.sub(s, 1, n)
end

local function enumValue(v)
	local ok, value = pcall(function() return v.Value end)
	if ok and type(value) == "number" then return value end
	return 0
end

-- One clip's bytes (status 0), or an error.
local function pack(id, seq)
	local names, nameAt = {}, {}
	local frames = {}
	for _, kf in seq:GetKeyframes() do
		if #frames >= MAX_FRAMES then break end
		local poses = {}
		local function walk(pose)
			if not pose:IsA("Pose") then return end
			if #poses < MAX_POSES then
				local name = cut(pose.Name, 255)
				local at = nameAt[name]
				if at == nil and #names < 65535 then
					table.insert(names, name)
					at = #names - 1
					nameAt[name] = at
				end
				if at ~= nil then
					local cf = pose.CFrame
					local qx, qy, qz, qw = quat(cf)
					table.insert(poses, string.pack("<I2ffffffffBBf", at, qx, qy, qz, qw, cf.X, cf.Y, cf.Z, enumValue(pose.EasingStyle), enumValue(pose.EasingDirection), pose.Weight))
				end
			end
			for _, sub in pose:GetSubPoses() do walk(sub) end
		end
		for _, pose in kf:GetPoses() do walk(pose) end
		table.insert(frames, string.pack("<fI2", kf.Time, #poses) .. table.concat(poses))
	end
	local out = { string.pack("<BBI2I2", 0, seq.Loop and 1 or 0, enumValue(seq.Priority), #names) }
	for _, name in names do table.insert(out, string.pack("<B", #name) .. name) end
	table.insert(out, string.pack("<I2", #frames))
	for _, f in frames do table.insert(out, f) end
	return table.concat(out)
end

local results = {}
local loaded, failed, skipped = 0, 0, 0
local nextIndex = 0
local active = 0
local function worker()
	active += 1
	while true do
		nextIndex += 1
		local i = nextIndex
		local id = IDS[i]
		if id == nil then break end
		if os.clock() > DEADLINE then
			results[i] = string.pack("<B", #id) .. id .. string.pack("<B", 2)
			skipped += 1
		else
			local ok, seq = pcall(function() return KSP:GetKeyframeSequenceAsync("rbxassetid://" .. id) end)
			local body
			if ok and seq then
				local packed, bytes = pcall(pack, id, seq)
				if packed then
					body = bytes
					loaded += 1
				else
					local msg = cut(tostring(bytes), 300)
					body = string.pack("<BI2", 1, #msg) .. msg
					failed += 1
				end
				pcall(function() seq:Destroy() end)
			else
				local msg = cut(tostring(ok and "no KeyframeSequence" or seq), 300)
				body = string.pack("<BI2", 1, #msg) .. msg
				failed += 1
			end
			results[i] = string.pack("<B", #id) .. id .. body
		end
	end
	active -= 1
end
for _ = 1, math.min(WORKERS, math.max(1, #IDS)) do task.spawn(worker) end
while active > 0 and os.clock() < DEADLINE + 30 do task.wait(0.05) end
-- A load still hanging past the grace: its id is written as skipped.
local parts = { "TTAN", string.pack("<I2I2", 1, #IDS) }
for i, id in IDS do
	if results[i] == nil then
		results[i] = string.pack("<B", #id) .. id .. string.pack("<B", 2)
		skipped += 1
	end
	table.insert(parts, results[i])
end
local bytes = table.concat(parts)

return {
	BinaryOutput = buffer.fromstring(bytes),
	ReturnValues = { HttpService:JSONEncode({
		placeId = game.PlaceId,
		placeVersion = game.PlaceVersion,
		ids = #IDS,
		loaded = loaded,
		failed = failed,
		skipped = skipped,
		bytes = #bytes,
		seconds = os.clock() - t0,
	}) },
}
`;
}
