/**
 * The read-only Luau script the map export runs (Open Cloud Luau Execution, binary output; plans/33). It changes nothing
 * in the place: it reads instances and returns a buffer (format.ts `TTMX`) plus a JSON summary.
 *
 * What it packs:
 *   - candidates: every Model or Folder in Workspace, ReplicatedStorage and ServerStorage whose Name, normalized
 *     (`mapKey`: lowercase, only a-z and 0-9), equals a wanted map name's (the `map` values seen in events, normalized
 *     the same way, so "parking_garage" finds "ParkingGarage"); and each manual override's model path.
 *     The backend picks one candidate per map name (match.ts `pickMaps`).
 *   - the lobby: every other BasePart in Workspace (not Terrain, not under a candidate or the camera).
 * Every BasePart counts, transparent or not (flagged). MeshParts and unions are their bounding boxes (flagged).
 * Past `maxParts` parts in all it stops adding and says `truncated`.
 */
import { RECORD_BYTES } from "./format.ts";

/** Where the script looks for map models, besides the overrides' own paths. */
export const SEARCH_ROOTS = ["Workspace", "ReplicatedStorage", "ServerStorage"] as const;
/** Parts per export, at most (48 bytes each: 24 MB). */
export const MAX_EXPORT_PARTS = 500_000;

/** How map names compare: lowercase, letters and digits only ("Parking Garage", "parking_garage" -> "parkinggarage"). */
export function mapKey(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A Luau string literal of any text (every byte that isn't a plain letter, digit, space or _ as a \ddd escape). */
export function luauString(text: string): string {
	let out = '"';
	for (const byte of new TextEncoder().encode(text)) {
		const ch = String.fromCharCode(byte);
		out += /[A-Za-z0-9 _]/.test(ch) ? ch : `\\${String(byte).padStart(3, "0")}`;
	}
	return `${out}"`;
}

export interface ScriptInput {
	/** Map names from the events (original spelling). */
	names: string[];
	/** Manual overrides: map name -> instance path ("ReplicatedStorage.assets.maps.Mall"). */
	overrides?: { name: string; path: string }[];
	maxParts?: number;
}

export function exportScript(input: ScriptInput): string {
	const wanted = new Map<string, string>();
	for (const name of input.names) {
		const key = mapKey(name);
		if (key && !wanted.has(key)) wanted.set(key, name);
	}
	const wantLines = [...wanted].map(([key, name]) => `\t[${luauString(key)}] = ${luauString(name)},`).join("\n");
	const overrideLines = (input.overrides ?? [])
		.filter((o) => o.path.trim() !== "")
		.map((o) => `\t{ name = ${luauString(o.name)}, path = { ${o.path.split(".").map((s) => luauString(s)).join(", ")} } },`)
		.join("\n");
	return `-- TypeTorch map export (read-only: reads instances, returns a buffer). Format: backend src/maps/format.ts.
local HttpService = game:GetService("HttpService")
local t0 = os.clock()
local WANT = {
${wantLines}
}
local OVERRIDES = {
${overrideLines}
}
local MAX_PARTS = ${Math.max(1, Math.floor(input.maxParts ?? MAX_EXPORT_PARTS))}
local RECORD = ${RECORD_BYTES}
local notes = {}

local function key(name)
	return (string.gsub(string.lower(name), "[^%w]", ""))
end

local candidates = {}
local claimed = {}
local function consider(inst, via, want)
	if claimed[inst] then return end
	claimed[inst] = true
	table.insert(candidates, { inst = inst, via = via, want = want })
end
for _, o in OVERRIDES do
	local node = game
	for _, seg in o.path do
		if node == nil then break end
		node = node:FindFirstChild(seg)
	end
	if node and node ~= game then consider(node, 1, o.name) else table.insert(notes, "override path not found: " .. table.concat(o.path, ".")) end
end
for _, svcName in { ${SEARCH_ROOTS.map((s) => luauString(s)).join(", ")} } do
	local ok, svc = pcall(function() return game:GetService(svcName) end)
	if ok and svc then
		for _, d in svc:GetDescendants() do
			if (d:IsA("Model") or d:IsA("Folder")) and d ~= workspace.Terrain then
				local want = WANT[key(d.Name)]
				if want then consider(d, 0, want) end
			end
		end
	end
end

local total = 0
local truncated = false
local function partsOf(root, skip)
	local list = {}
	local function add(p)
		if total >= MAX_PARTS then truncated = true return end
		if skip and skip[p] then return end
		table.insert(list, p)
		total += 1
	end
	if root:IsA("BasePart") and root.ClassName ~= "Terrain" then add(root) end
	for _, d in root:GetDescendants() do
		if d:IsA("BasePart") and d.ClassName ~= "Terrain" then add(d) end
	end
	return list
end

local entries = {}
local covered = {}
for _, c in candidates do
	local list = partsOf(c.inst)
	for _, p in list do covered[p] = true end
	table.insert(entries, { kind = 0, via = c.via, name = c.inst.Name, want = c.want, path = c.inst:GetFullName(), parts = list })
end
-- The lobby: Workspace's other parts (not under a candidate, the camera or Terrain).
local camera = workspace.CurrentCamera
if camera then for _, d in camera:GetDescendants() do covered[d] = true end end
local lobby = {}
for _, d in workspace:GetDescendants() do
	if d:IsA("BasePart") and d.ClassName ~= "Terrain" and not covered[d] then
		if total >= MAX_PARTS then truncated = true break end
		table.insert(lobby, d)
		total += 1
	end
end
table.insert(entries, { kind = 1, via = 2, name = "Workspace", want = "", path = "Workspace", parts = lobby })
local scanSeconds = os.clock() - t0

local function cut(s, n)
	if #s <= n then return s end
	return string.sub(s, 1, n)
end
local size = 8
for _, e in entries do
	e.name = cut(e.name, 255)
	e.want = cut(e.want, 255)
	e.path = cut(e.path, 1024)
	size += 3 + #e.name + 1 + #e.want + 2 + #e.path + 4 + #e.parts * RECORD
end
local buf = buffer.create(size)
local o = 0
buffer.writestring(buf, 0, "TTMX")
buffer.writeu16(buf, 4, 1)
buffer.writeu16(buf, 6, #entries)
o = 8
local function u8(v) buffer.writeu8(buf, o, v) o += 1 end
local function str8(s) u8(#s) buffer.writestring(buf, o, s) o += #s end

local function clamp8(v)
	v = math.floor(v * 255 + 0.5)
	if v < 0 then return 0 elseif v > 255 then return 255 end
	return v
end

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

local counts = {}
for _, e in entries do
	u8(e.kind)
	u8(e.via)
	str8(e.name)
	str8(e.want)
	buffer.writeu16(buf, o, #e.path) o += 2
	buffer.writestring(buf, o, e.path) o += #e.path
	buffer.writeu32(buf, o, #e.parts) o += 4
	local meshes = 0
	for _, p in e.parts do
		local cf = p.CFrame
		local qx, qy, qz, qw = quat(cf)
		local s = p.Size
		local c = p.Color
		buffer.writef32(buf, o, cf.X) buffer.writef32(buf, o + 4, cf.Y) buffer.writef32(buf, o + 8, cf.Z)
		buffer.writef32(buf, o + 12, qx) buffer.writef32(buf, o + 16, qy) buffer.writef32(buf, o + 20, qz) buffer.writef32(buf, o + 24, qw)
		buffer.writef32(buf, o + 28, s.X) buffer.writef32(buf, o + 32, s.Y) buffer.writef32(buf, o + 36, s.Z)
		buffer.writeu8(buf, o + 40, clamp8(c.R)) buffer.writeu8(buf, o + 41, clamp8(c.G)) buffer.writeu8(buf, o + 42, clamp8(c.B))
		buffer.writeu8(buf, o + 43, clamp8(p.Transparency))
		buffer.writeu16(buf, o + 44, p.Material.Value)
		local shape = 1
		if p:IsA("Part") then shape = p.Shape.Value
		elseif p:IsA("WedgePart") then shape = 3
		elseif p:IsA("CornerWedgePart") then shape = 4 end
		buffer.writeu8(buf, o + 46, shape)
		local flags = 0
		if p:IsA("MeshPart") then flags += 1 meshes += 1 end
		if p:IsA("PartOperation") then flags += 2 end
		if p.Transparency >= ${0.95} then flags += 4 end
		if p.CanCollide then flags += 8 end
		if p:IsA("TrussPart") then flags += 16 end
		buffer.writeu8(buf, o + 47, flags)
		o += RECORD
	end
	table.insert(counts, { name = e.name, want = e.want, path = e.path, parts = #e.parts, meshes = meshes })
end

return {
	BinaryOutput = buf,
	ReturnValues = { HttpService:JSONEncode({
		placeId = game.PlaceId,
		placeVersion = game.PlaceVersion,
		entries = counts,
		parts = total,
		bytes = size,
		truncated = truncated,
		terrainCells = workspace.Terrain:CountCells(),
		scanSeconds = scanSeconds,
		seconds = os.clock() - t0,
		notes = notes,
	}) },
}
`;
}
