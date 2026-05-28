extends Node2D


const GRID_SIZE = 20
const DEFAULT_MAP_WIDTH = 160
const DEFAULT_MAP_HEIGHT = 90
const MAX_MAP_WIDTH = 640
const MAX_MAP_HEIGHT = 360

enum StarType {
	NORMAL = 1,
	CLUSTER = 2,
	WORMHOLE = 3,
	BLACK_HOLE = 4
}

var map_width = DEFAULT_MAP_WIDTH
var map_height = DEFAULT_MAP_HEIGHT
var stars = []
var lines = []
var camera: Camera2D
var current_star_type = StarType.NORMAL
var line_start = null
var ghost_star = null
var ghost_line = null
var saving_overlay = false
var loading_overlay = false
var settings_overlay = false
var tips_overlay = true
var map_title = "Untitled Map"
var map_author = "Creator"

# UI Elements
var canvas_layer: CanvasLayer
var overlay_panel: Panel
var width_input: LineEdit
var height_input: LineEdit
var tips_label: Label
var title_edit: LineEdit
var file_dialog: FileDialog

var value_panel: Panel
var min_value_input: SpinBox
var max_value_input: SpinBox
var selected_star_index: int = -1

var stats_container: VBoxContainer  # Changed from HBoxContainer to VBoxContainer
var connection_counter_label: Label
var coordinate_label: Label  # New label for coordinates

var action_history = []
var current_action_index = -1
const MAX_HISTORY = 100


func _ready():
	setup_camera()
	setup_ui()
	ghost_star = true
	
	# Add HTML5 drag and drop handlers if running in browser
	if OS.has_feature("web"):
		# Get the canvas element
		var canvas = JavaScriptBridge.get_interface("canvas")
		
		# Prevent default drag behavior
		JavaScriptBridge.eval("""
			canvas.addEventListener('dragover', function(e) {
				e.preventDefault();
				e.stopPropagation();
			});
			
			canvas.addEventListener('drop', function(e) {
				e.preventDefault();
				e.stopPropagation();
				
				if (e.dataTransfer.files.length > 0) {
					const file = e.dataTransfer.files[0];
					if (!file.name.toLowerCase().endsWith('.json')) {
						alert('Only JSON files are supported.');
						return;
					}
					
					const reader = new FileReader();
					reader.onload = function(event) {
						const fileContent = event.target.result;
						window.godot_instance.load_map_from_js(fileContent);
					};
					reader.readAsText(file);
				}
			});
		""")
		# Add JavaScript method to window.godot_instance
		JavaScriptBridge.eval("""
			window.godot_instance = {
				load_map_from_js: function(content) {
					window.godot.load_map_from_js(content);
				}
			};
		""")

# Add method to receive map data from JavaScript
func load_map_from_js(file_content: String):
	load_map(file_content)

func _notification(what):
	if what == NOTIFICATION_WEB_DRAG_ENTER:
		# Visual feedback when dragging over (optional)
		pass
	elif what == NOTIFICATION_WEB_DROP:
		# Handle drop event (backup handler)
		pass


func setup_camera():
	camera = Camera2D.new()
	add_child(camera)
	camera.make_current()
	camera.position = Vector2(map_width * GRID_SIZE / 2, map_height * GRID_SIZE / 2)
	set_initial_zoom()
	
# Utility function to get all connected lines for a star index
func get_connected_lines(star_index: int) -> Array:
	var connected = []
	for i in range(lines.size()):
		var line = lines[i]
		if line.from == star_index or line.to == star_index:
			# Store line with its index
			connected.append({
				"index": i,
				"data": line.duplicate()
			})
	return connected

# Utility function to adjust line indices after star removal
func adjust_line_indices(removed_index: int):
	for line in lines:
		if line.from > removed_index:
			line.from -= 1
		if line.to > removed_index:
			line.to -= 1

func record_action(action_type: String, data: Dictionary):
	# Remove any actions after current index if we're in middle of history
	while action_history.size() > current_action_index + 1:
		action_history.pop_back()
	
	# Add new action
	action_history.append({
		"type": action_type,
		"data": data
	})
	
	# Limit history size
	if action_history.size() > MAX_HISTORY:
		action_history.pop_front()
		current_action_index = max(0, current_action_index)
	else:
		current_action_index += 1

func undo():
	if current_action_index >= 0:
		var action = action_history[current_action_index]
		
		match action.type:
			"add_star":
				# Get all connected lines before removing the star
				var connected_lines = get_connected_lines(action.data.index)
				# Remove the star and its connected lines
				remove_star_and_lines(action.data.index)
				# Store the connected lines in the action for redo
				action.data["connected_lines"] = connected_lines
				
			"remove_star":
				# First, insert the star at its original index
				stars.insert(action.data.index, action.data.star.duplicate())
				# Then restore all connected lines
				for line_data in action.data.connected_lines:
					lines.insert(line_data.index, line_data.data.duplicate())
				
			"change_star":
				# Restore previous star state
				stars[action.data.index] = action.data.old_state.duplicate()
				
			"add_line":
				# Remove the line at its stored index
				lines.remove_at(action.data.index)
				
			"remove_line":
				# Restore the line at its original index
				lines.insert(action.data.index, action.data.line.duplicate())
		
		current_action_index -= 1
		queue_redraw()
		update_connection_counter()

func redo():
	if current_action_index < action_history.size() - 1:
		current_action_index += 1
		var action = action_history[current_action_index]
		
		match action.type:
			"add_star":
				# Re-add the star at its original index
				stars.insert(action.data.index, action.data.star.duplicate())
				# Restore any connected lines
				if action.data.has("connected_lines"):
					for line_data in action.data.connected_lines:
						lines.insert(line_data.index, line_data.data.duplicate())
				
			"remove_star":
				# Remove the star and its lines again
				remove_star_and_lines(action.data.index)
				
			"change_star":
				# Apply the change again
				stars[action.data.index] = action.data.new_state.duplicate()
				
			"add_line":
				# Re-add the line at its original index
				lines.insert(action.data.index, action.data.line.duplicate())
				
			"remove_line":
				# Remove the line from its stored index
				lines.remove_at(action.data.index)
		
		queue_redraw()
		update_connection_counter()
func create_button_theme() -> Theme:
	var theme = Theme.new()
	
	# Create StyleBoxFlat for normal state
	var spinbox_style = StyleBoxFlat.new()
	spinbox_style.bg_color = Color(0.1, 0.1, 0.1, 1)
	spinbox_style.border_color = Color(0.8, 0.8, 0.8, 1)
	spinbox_style.border_width_left = 1
	spinbox_style.border_width_right = 1
	spinbox_style.border_width_top = 1
	spinbox_style.border_width_bottom = 1
	spinbox_style.corner_radius_top_left = 0
	spinbox_style.corner_radius_top_right = 0
	spinbox_style.corner_radius_bottom_left = 0
	spinbox_style.corner_radius_bottom_right = 0
	# Create minimal style for normal state
	var normal_style = StyleBoxFlat.new()
	normal_style.bg_color = Color(0.15, 0.15, 0.15, 1)  # Dark background
	normal_style.border_color = Color(0.8, 0.8, 0.8, 1)  # Light border
	normal_style.border_width_left = 1
	normal_style.border_width_right = 1
	normal_style.border_width_top = 1
	normal_style.border_width_bottom = 1
	normal_style.corner_radius_top_left = 0
	normal_style.corner_radius_top_right = 0
	normal_style.corner_radius_bottom_left = 0
	normal_style.corner_radius_bottom_right = 0
	
	# Create minimal style for hover state
	var hover_style = StyleBoxFlat.new()
	hover_style.bg_color = Color(0.2, 0.2, 0.2, 1)
	hover_style.border_color = Color(0.9, 0.9, 0.9, 1)
	hover_style.border_width_left = 1
	hover_style.border_width_right = 1
	hover_style.border_width_top = 1
	hover_style.border_width_bottom = 1
	hover_style.corner_radius_top_left = 0
	hover_style.corner_radius_top_right = 0
	hover_style.corner_radius_bottom_left = 0
	hover_style.corner_radius_bottom_right = 0
	
	# Create minimal style for pressed state
	var pressed_style = StyleBoxFlat.new()
	pressed_style.bg_color = Color(0.25, 0.25, 0.25, 1)
	pressed_style.border_color = Color(1, 1, 1, 1)
	pressed_style.border_width_left = 1
	pressed_style.border_width_right = 1
	pressed_style.border_width_top = 1
	pressed_style.border_width_bottom = 1
	pressed_style.corner_radius_top_left = 0
	pressed_style.corner_radius_top_right = 0
	pressed_style.corner_radius_bottom_left = 0
	pressed_style.corner_radius_bottom_right = 0
	
	# Create minimal style for panels
	var panel_style = StyleBoxFlat.new()
	panel_style.bg_color = Color(0.15, 0.15, 0.15, 0.95)
	panel_style.border_color = Color(0.8, 0.8, 0.8, 1)
	panel_style.border_width_left = 1
	panel_style.border_width_right = 1
	panel_style.border_width_top = 1
	panel_style.border_width_bottom = 1
	panel_style.corner_radius_top_left = 0
	panel_style.corner_radius_top_right = 0
	panel_style.corner_radius_bottom_left = 0
	panel_style.corner_radius_bottom_right = 0
	
	# Create minimal style for line edit
	var line_edit_style = StyleBoxFlat.new()
	line_edit_style.bg_color = Color(0.1, 0.1, 0.1, 1)
	line_edit_style.border_color = Color(0.8, 0.8, 0.8, 1)
	line_edit_style.border_width_left = 1
	line_edit_style.border_width_right = 1
	line_edit_style.border_width_top = 1
	line_edit_style.border_width_bottom = 1
	line_edit_style.corner_radius_top_left = 0
	line_edit_style.corner_radius_top_right = 0
	line_edit_style.corner_radius_bottom_left = 0
	line_edit_style.corner_radius_bottom_right = 0
	
	# Create minimal style for spinbox

	
	# Apply styles to theme
	theme.set_stylebox("normal", "Button", normal_style)
	theme.set_stylebox("hover", "Button", hover_style)
	theme.set_stylebox("pressed", "Button", pressed_style)
	theme.set_stylebox("panel", "Panel", panel_style)
	theme.set_stylebox("normal", "LineEdit", line_edit_style)
	theme.set_stylebox("normal", "SpinBox", spinbox_style)

	
	# Set colors
	theme.set_color("font_color", "Button", Color(1, 1, 1, 1))
	theme.set_color("font_hover_color", "Button", Color(1, 1, 1, 1))
	theme.set_color("font_pressed_color", "Button", Color(1, 1, 1, 1))
	theme.set_color("font_color", "LineEdit", Color(1, 1, 1, 1))
	theme.set_color("font_color", "SpinBox", Color(1, 1, 1, 1))
	theme.set_color("font_color", "Label", Color(1, 1, 1, 1))
	
	return theme


# ... (previous code until setup_ui function remains the same)

func setup_ui():
	var load_text_input: TextEdit
	var load_button: Button
	# Create text input for JSON
	load_text_input = TextEdit.new()
	load_text_input.custom_minimum_size = Vector2(300, 150)
	load_text_input.placeholder_text = "Paste map JSON here..."
	load_text_input.position = Vector2(10, 200)  # Position below other controls
	load_text_input.wrap_mode = TextEdit.WRAP_MODE_WORDCHAR

# Create load from text button
	load_button = Button.new()
	load_button.text = "Load from Text"
	load_button.theme = button_theme
	load_button.custom_minimum_size = Vector2(100, 30)
	load_button.pressed.connect(func():
		var text = load_text_input.text.strip_edges()
		if text:
			load_map(text)
	)
	load_text_input.position = Vector2(10, 250)  # Adjust position as needed
	load_button.position = Vector2(10, 410)  # Position below text input

# Add to canvas layer
	canvas_layer.add_child(load_text_input)
	canvas_layer.add_child(load_button)

	canvas_layer = CanvasLayer.new()
	add_child(canvas_layer)

	# Create custom button theme
	var button_theme = create_button_theme()

	# Create title edit centered on screen
	title_edit = LineEdit.new()
	title_edit.text = "Untitled by Creator"
	title_edit.placeholder_text = "Enter map title..."
	title_edit.custom_minimum_size = Vector2(300, 30)
	title_edit.alignment = HORIZONTAL_ALIGNMENT_CENTER
	
	# Get viewport size for centering
	var viewport_size = get_viewport_rect().size
	title_edit.position = Vector2((viewport_size.x - title_edit.custom_minimum_size.x) / 2, 10)

	# Add the stats container in top right (now as VBoxContainer)
	stats_container = VBoxContainer.new()
	stats_container.position = Vector2(viewport_size.x - 200, 10)  # Position in top right
	stats_container.add_theme_constant_override("separation", 2)  # Small gap between labels
	
	# Add connection counter label
	connection_counter_label = Label.new()
	connection_counter_label.text = "0 stars / 0 cons"
	var font_size = 15
	connection_counter_label.add_theme_font_size_override("font_size", font_size)
	stats_container.add_child(connection_counter_label)
	
	# Add coordinate label
	coordinate_label = Label.new()
	coordinate_label.text = ""  # Empty by default
	coordinate_label.add_theme_font_size_override("font_size", font_size)
	stats_container.add_child(coordinate_label)
	
	canvas_layer.add_child(stats_container)
	
	# Set up font size


	# Enforce the format: "[Title] by [Name]"
	var is_programmatic_change = false
	
	title_edit.text_changed.connect(func(new_text):
		# Prevent recursive calls from programmatic changes
		if is_programmatic_change:
			return
			
		# Split the text into title and name parts
		var parts = new_text.split(" by ")
		var title = ""
		var name = ""
		
		# Handle different cases
		if parts.size() >= 2:
			title = parts[0].strip_edges()
			name = parts[1].strip_edges()
		elif parts.size() == 1:
			title = parts[0].strip_edges()
			if new_text.ends_with(" b") or new_text.ends_with(" by"):
				name = ""
			else:
				name = map_author
		
		if title == "Untitled" or title == "":
			map_title = ""
		else:
			map_title = title
			
		if name == "Creator" or name == "":
			map_author = ""
		else:
			map_author = name
		
		title = map_title if map_title != "" else "Untitled"
		name = map_author if map_author != "" else "Creator"
		
		var formatted_text = title + " by " + name
		
		if formatted_text != title_edit.text:
			is_programmatic_change = true
			title_edit.text = formatted_text
			title_edit.caret_column = new_text.length()
			is_programmatic_change = false
	)
	
	title_edit.text = "Untitled by Creator"
	
	var style = StyleBoxEmpty.new()
	title_edit.add_theme_stylebox_override("normal", style)
	title_edit.add_theme_stylebox_override("focus", style)
	canvas_layer.add_child(title_edit)

	# Create file dialog
	file_dialog = FileDialog.new()
	file_dialog.access = FileDialog.ACCESS_FILESYSTEM
	file_dialog.file_mode = FileDialog.FILE_MODE_SAVE_FILE
	file_dialog.filters = ["*.json ; JSON Files"]
	canvas_layer.add_child(file_dialog)

	# Create main container for controls
	var main_container = HBoxContainer.new()
	main_container.position = Vector2(10, 10)
	main_container.add_theme_constant_override("separation", 10)
	canvas_layer.add_child(main_container)

	# Left container for resolution controls
	var resolution_container = VBoxContainer.new()
	resolution_container.add_theme_constant_override("separation", 5)
	main_container.add_child(resolution_container)

	# Width control
	var width_container = HBoxContainer.new()
	var width_label = Label.new()
	width_label.text = "Width:"
	width_container.add_child(width_label)

	var width_spinbox = SpinBox.new()
	width_spinbox.min_value = 1
	width_spinbox.max_value = MAX_MAP_WIDTH
	width_spinbox.value = map_width
	width_spinbox.custom_minimum_size = Vector2(100, 30)
	width_spinbox.value_changed.connect(func(new_width): update_map_size(new_width, map_height))
	width_container.add_child(width_spinbox)
	resolution_container.add_child(width_container)

	# Height control
	var height_container = HBoxContainer.new()
	var height_label = Label.new()
	height_label.text = "Height:"
	height_container.add_child(height_label)

	var height_spinbox = SpinBox.new()
	height_spinbox.min_value = 1
	height_spinbox.max_value = MAX_MAP_HEIGHT
	height_spinbox.value = map_height
	height_spinbox.custom_minimum_size = Vector2(100, 30)
	height_spinbox.value_changed.connect(func(new_height): update_map_size(map_width, new_height))
	height_container.add_child(height_spinbox)
	resolution_container.add_child(height_container)

	# Right container for save/load buttons
	var button_container = VBoxContainer.new()
	button_container.add_theme_constant_override("separation", 5)
	main_container.add_child(button_container)

	# Save button
	var save_button = Button.new()
	save_button.text = "Save Map"
	save_button.theme = button_theme
	save_button.custom_minimum_size = Vector2(100, 30)
	save_button.pressed.connect(show_save_dialog)
	button_container.add_child(save_button)

	# Load button
	load_button.text = "Load Map"
	load_button.theme = button_theme
	load_button.custom_minimum_size = Vector2(100, 30)
	load_button.pressed.connect(show_load_dialog)
	button_container.add_child(load_button)
	
	setup_tips_overlay()
	setup_value_panel()
	update_connection_counter()

func update_connection_counter():
	if connection_counter_label:
		connection_counter_label.text = str(stars.size()) + " stars / " + str(lines.size()) + " cons"

func update_map_size(new_width: int, new_height: int):
	# Store old dimensions
	var old_width = map_width
	var old_height = map_height
	
	# Update dimensions
	map_width = new_width
	map_height = new_height
	
	# Remove stars outside new bounds
	var i = stars.size() - 1
	while i >= 0:
		var star = stars[i]
		if star.x >= map_width or star.y >= map_height:
			# Remove any lines connected to this star
			var j = lines.size() - 1
			while j >= 0:
				if lines[j].from == i or lines[j].to == i:
					lines.remove_at(j)
				j -= 1
			# Remove the star
			stars.remove_at(i)
		i -= 1
	
	# Update camera position and zoom
	camera.position = Vector2(map_width * GRID_SIZE / 2, map_height * GRID_SIZE / 2)
	set_initial_zoom()
	
	# Redraw
	queue_redraw()

# Save/Load Functions
func show_save_dialog():
	file_dialog.file_mode = FileDialog.FILE_MODE_SAVE_FILE
	file_dialog.title = "Save Map"
	file_dialog.current_file = map_title.strip_edges().to_lower().replace(" ", "_") + ".json"
	file_dialog.file_selected.connect(save_map, CONNECT_ONE_SHOT)
	file_dialog.popup_centered(Vector2(800, 600))

func save_map(path: String):
	var save_data = {
		"title": map_title,
		"width": map_width,
		"height": map_height,
		"stars": stars,
		"lines": lines
	}
	
	var json_string = JSON.stringify(save_data)
	JavaScriptBridge.download_buffer(json_string.to_utf8_buffer(), map_title + ".json")

func load_map(file_content: String):
	var json = JSON.new()
	var parse_result = json.parse(file_content)
	
	if parse_result == OK:
		var data = json.data
		map_title = data.get("title", "Untitled Map")
		map_width = data.get("width", DEFAULT_MAP_WIDTH)
		map_height = data.get("height", DEFAULT_MAP_HEIGHT)
		stars = data.get("stars", [])
		lines = data.get("lines", [])
		
		# Update UI and redraw
		title_edit.text = map_title + " by Creator"
		camera.position = Vector2(map_width * GRID_SIZE / 2, map_height * GRID_SIZE / 2)
		set_initial_zoom()
		queue_redraw()
		update_connection_counter()

func show_load_dialog():
	var load_hint = """
	Load Map:
	1. Paste previously saved map JSON in the text box.
	2. Click 'Load from Text' button.
	"""
	OS.alert(load_hint, "Load Map")

func setup_tips_overlay():
	var tips_label = Label.new()
	tips_label.text = """
	1 - Normal  2 - Cluster  3 - Wormhole  4 - Black Hole
	Double right click - edit star req
	"""
	
	# Get viewport size for positioning
	var viewport_size = get_viewport_rect().size
	
	# Set up font size
	var font_size = 14  # You can adjust this value
	tips_label.add_theme_font_size_override("font_size", font_size)
	
	tips_label.position = Vector2(10, viewport_size.y - 100)  # Position at bottom left
	canvas_layer.add_child(tips_label)

func set_initial_zoom():
	var viewport_size = get_viewport_rect().size
	var map_size = Vector2(map_width * GRID_SIZE, map_height * GRID_SIZE)
	var zoom = min(viewport_size.x / map_size.x, viewport_size.y / map_size.y) * 0.9
	camera.zoom = Vector2(zoom, zoom)

func _draw():
	# Draw grid with improved visibility
	var grid_color = Color(0.2, 0.2, 0.2, 0.3)  # Darker, semi-transparent color
	
	# Draw major grid lines (every 5 cells) slightly more visible
	for x in range(map_width + 1):
		var line_color = grid_color
		var line_width = 1.0
		if x % 10 == 0:  # Major grid lines
			line_color = Color(0.3, 0.3, 0.3, 1)
			line_width = 1.5
		
		draw_line(
			Vector2(x * GRID_SIZE, map_height * GRID_SIZE),
			Vector2(x * GRID_SIZE, 0),
			line_color,
			line_width
		)
	
	for y in range(map_height + 1):
		var line_color = grid_color
		var line_width = 1.0
		if y % 10 == 0:  # Major grid lines
			line_color = Color(0.3, 0.3, 0.3, 1)
			line_width = 1.5
			
		draw_line(
			Vector2(0, map_height * GRID_SIZE - y * GRID_SIZE),
			Vector2(map_width * GRID_SIZE, map_height * GRID_SIZE - y * GRID_SIZE),
			line_color,
			line_width
		)

	
	# Draw existing lines
	for line in lines:
		var start = stars[line.from]
		var end = stars[line.to]
		var start_pos = Vector2(start.x * GRID_SIZE, start.y * GRID_SIZE)
		var end_pos = Vector2(end.x * GRID_SIZE, end.y * GRID_SIZE)
		
		# Check if there's a ghost line that would delete this line
		var line_color = Color.WHITE
		if ghost_line:
			var ghost_start = Vector2(ghost_line.start_x * GRID_SIZE, ghost_line.start_y * GRID_SIZE)
			var ghost_end = get_global_mouse_position()
			var clicked_star = find_clicked_star(ghost_end)
			
			if clicked_star != -1:
				var potential_end = stars[clicked_star]
				var ghost_end_pos = Vector2(potential_end.x * GRID_SIZE, potential_end.y * GRID_SIZE)
				
				# Check if lines match (in either direction)
				if (ghost_start.is_equal_approx(start_pos) and ghost_end_pos.is_equal_approx(end_pos)) or \
				   (ghost_start.is_equal_approx(end_pos) and ghost_end_pos.is_equal_approx(start_pos)):
					line_color = Color(1, 0.25, 0.25)
		
		draw_line(start_pos, end_pos, line_color, 2.0)
		
		# Calculate midpoint for label positioning
		var midpoint = (start_pos + end_pos) / 2
		
		# Calculate score and format as string
		var score = (start_pos - end_pos).length()
		var score_text = str(int(score))
		
		# Calculate angle for rotation
		var angle = atan2(end_pos.y - start_pos.y, end_pos.x - start_pos.x)
		
		# Ensure text is always readable (not upside down)
		if abs(angle) > PI/2:
			angle += PI
		
		# Calculate offset for label position
		var perpendicular = Vector2(-sin(angle), cos(angle))  # Vector perpendicular to line
		var label_offset = perpendicular * (GRID_SIZE / -7)  # Offset for higher placement
		var label_pos = Vector2(round(midpoint.x), round(midpoint.y)) + label_offset
		
		# Draw the text using Godot 4's text drawing method
		var font = ThemeDB.fallback_font
		var font_size = 10
		
		# Create a transform for rotation
		var transform = Transform2D().rotated(angle)
		transform.origin = Vector2(round(label_pos.x), round(label_pos.y))
		
		# Draw the rotated text
		# Calculate text width and offset horizontally
		var text_width = font.get_string_size(score_text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x
		var centered_pos = Vector2(-text_width/2, 0)  # Offset by half text width

# Draw the rotated text
		draw_set_transform_matrix(transform)
		draw_string(font, centered_pos, score_text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, line_color)
		draw_set_transform_matrix(Transform2D())  # Reset transform
		
	
	# Draw ghost line if active
	if ghost_line:
		var start_pos = Vector2(ghost_line.start_x * GRID_SIZE, ghost_line.start_y * GRID_SIZE)
		var mouse_pos = get_global_mouse_position()
		var grid_pos = get_grid_position(mouse_pos)
		var end_pos = mouse_pos  # Default to mouse position
		var line_color = Color(1, 1, 1, 0.5)  # Default semi-transparent white
		
		# Find if we're hovering over a valid end star
		var clicked_star = find_clicked_star(mouse_pos)
		
		if clicked_star != -1:
			# If hovering over a star, snap to it
			var potential_end = stars[clicked_star]
			end_pos = Vector2(potential_end.x * GRID_SIZE, potential_end.y * GRID_SIZE)
			
			# Check if this would create a duplicate line
			var would_be_duplicate = false
			for line in lines:
				var start = stars[line.from]
				var end = stars[line.to]
				if (start.x == ghost_line.start_x and start.y == ghost_line.start_y and 
					end.x == potential_end.x and end.y == potential_end.y) or \
				   (end.x == ghost_line.start_x and end.y == ghost_line.start_y and 
					start.x == potential_end.x and start.y == potential_end.y):
					would_be_duplicate = true
					line_color = Color(1, 0.25, 0.25, 1)  # Bright red for deletion
					break
			
			# If not a duplicate, check for line intersection
			if not would_be_duplicate:
				var start_grid = Vector2(ghost_line.start_x, ghost_line.start_y)
				var end_grid = Vector2(potential_end.x, potential_end.y)
				
				for line in lines:
					var existing_start = Vector2(stars[line.from].x, stars[line.from].y)
					var existing_end = Vector2(stars[line.to].x, stars[line.to].y)
					
					if do_lines_overlap(start_grid, end_grid, existing_start, existing_end):
						line_color = Color(1, 0.25, 0.25, 0.5)  # Semi-transparent red for overlap
						break
		
		# Draw the line
		draw_line(start_pos, end_pos, line_color, 2.0)
		
		# Draw distance label if snapped to a star
		var midpoint = (start_pos + end_pos) / 2
		var score = (start_pos - end_pos).length()
		var score_text = str(int(score))
		
		var angle = atan2(end_pos.y - start_pos.y, end_pos.x - start_pos.x)
		if abs(angle) > PI/2:
			angle += PI
				
		var perpendicular = Vector2(-sin(angle), cos(angle))
		var label_offset = perpendicular * (GRID_SIZE / -7)
		var label_pos = Vector2(round(midpoint.x), round(midpoint.y)) + label_offset
			
		var font = ThemeDB.fallback_font
		var font_size = 10
			
		var transform = Transform2D().rotated(angle)
		transform.origin = Vector2(round(label_pos.x), round(label_pos.y))
			
			# Calculate text width for centering
		var text_width = font.get_string_size(score_text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x
		var centered_pos = Vector2(-text_width/2, 0)
			
		draw_set_transform_matrix(transform)
		draw_string(font, centered_pos, score_text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, line_color)
		draw_set_transform_matrix(Transform2D())
	
		# Draw existing stars
	for star in stars:
		var color = Color.WHITE
		if ghost_star:
			var grid_pos = get_grid_position(get_global_mouse_position())
			if star.x == grid_pos.x and star.y == grid_pos.y:
				color = Color(1, 0.25, 0.25, 0.5)
		draw_star(star, color)
	
	# Draw ghost star if active
	if ghost_star:
		var grid_pos = get_grid_position(get_global_mouse_position())
		var is_valid_position = is_valid_grid_position(grid_pos)
		var existing_star = find_star_at_position(grid_pos.x, grid_pos.y)
		
		if is_valid_position:
			if existing_star == -1:
				# Show new star placement
				var ghost = {"x": grid_pos.x, "y": grid_pos.y, "type": current_star_type}
				draw_star(ghost, Color(1, 1, 1, 0.5))
			else:
				# Show both the red existing star and the ghost of the new star
				var existing = stars[existing_star]
				draw_star(existing, Color(1, 0.25, 0.25, 0.5))  # Draw existing star in red
				
				# If star types are different, show the ghost of the new star
				if existing.type != current_star_type:
					var ghost = {"x": grid_pos.x, "y": grid_pos.y, "type": current_star_type}
					draw_star(ghost, Color(1, 1, 1, 0.5))
		else:
			# Show red ghost star when outside grid
			var ghost = {"x": grid_pos.x, "y": grid_pos.y, "type": current_star_type}
			draw_star(ghost, Color(1, 0.25, 0.25, 0.5))
	# Check for hovered star
	var mouse_pos = get_global_mouse_position()
	var hovered_star = find_clicked_star(mouse_pos)
	
	if hovered_star != -1:
		var star = stars[hovered_star]
		coordinate_label.text = "%d. %d" % [star.x, star.y]
		coordinate_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	else:
		coordinate_label.text = ""

func remove_star_and_lines(star_index: int):
	# Remove all lines connected to this star first
	var lines_to_remove = []
	for i in range(lines.size()):
		var line = lines[i]
		if line.from == star_index or line.to == star_index:
			lines_to_remove.append(i)
			
	# Remove lines from highest index to lowest to avoid shifting issues
	lines_to_remove.sort()
	lines_to_remove.reverse()
	for line_index in lines_to_remove:
		lines.remove_at(line_index)
	
	# Remove the star
	stars.remove_at(star_index)
	
	# Update remaining line indices
	for line in lines:
		if line.from > star_index:
			line.from -= 1
		if line.to > star_index:
			line.to -= 1
	update_connection_counter()

func draw_star(star, color: Color):
	var pos = Vector2(star.x * GRID_SIZE, star.y * GRID_SIZE)
	var size = GRID_SIZE / 2

	match star.type:
		StarType.NORMAL:
			draw_circle(pos, size, color)
		StarType.CLUSTER:
			size *= 1.5
			var rect = Rect2(pos - Vector2(size, size), Vector2(size * 2, size * 2))
			draw_rect(rect, color)
		StarType.WORMHOLE:
			size *= 2  
			draw_wormhole(pos, size, color, get_requirement_text(star))
		StarType.BLACK_HOLE:
			size *= 1.5
			# Draw white/colored background
			draw_circle(pos, size, color)
			# Draw black center
			draw_circle(pos, size * 0.8, Color.BLACK)
			# Only draw requirement text if it's not the default case (2-2)
			var requirement_text = get_requirement_text(star)
			if requirement_text != "":
				draw_star_requirement(pos + Vector2(0, size * 0.4), requirement_text, Color.WHITE)
func get_requirement_text(star) -> String:
	var min_val = star.get("min_value", 2)
	var max_val = star.get("max_value", 2)
	
	# Special case: both values are 2, return empty string
	if min_val == 2 and max_val == 2:
		return ""
		
	# Convert 1 to infinity symbol
	var min_display = "∞" if min_val == 1 else str(min_val)
	var max_display = "∞" if max_val == 1 else str(max_val)
	
	if min_val == max_val:
		return min_display
	else:
		return min_display + "-" + max_display

func draw_wormhole(pos: Vector2, size: float, color: Color, requirement_text: String):
	# Draw triangle
	var points = PackedVector2Array([
		pos + Vector2(0, size),  # Bottom point
		pos + Vector2(-size * 0.866, -size * 0.5),  # Top left
		pos + Vector2(size * 0.866, -size * 0.5)  # Top right
	])
	draw_colored_polygon(points, color)

	# Only draw text if it's not empty
	if requirement_text != "":
		draw_star_requirement(pos + Vector2(0, size * 0.3), requirement_text, Color.BLACK if color.a < 1 else Color.BLACK)

func draw_star_requirement(pos: Vector2, requirement_text: String, color: Color):
	var font = ThemeDB.fallback_font
	var font_size = GRID_SIZE / 1.5
	var text_size = font.get_string_size(requirement_text, HORIZONTAL_ALIGNMENT_CENTER, -1, font_size)
	draw_string(font, pos - text_size / 2 + Vector2(0, 7), requirement_text, HORIZONTAL_ALIGNMENT_CENTER, -1, font_size, color)

func _input(event):
	if event is InputEventMouseMotion:
		if event.button_mask == MOUSE_BUTTON_MASK_MIDDLE:
			camera.position -= event.relative / camera.zoom
		queue_redraw()  # This will now also update the coordinate display
	if event is InputEventKey and event.pressed:
		# Handle undo/redo shortcuts
		if event.keycode == KEY_Z:
			if event.ctrl_pressed and event.shift_pressed:
				redo()
				return
			elif event.ctrl_pressed:
				undo()
				return
	if event is InputEventKey and event.pressed:
		match event.keycode:
			KEY_1:
				current_star_type = StarType.NORMAL
				ghost_star = true
			KEY_2:
				current_star_type = StarType.CLUSTER
				ghost_star = true
			KEY_3:
				current_star_type = StarType.WORMHOLE
				ghost_star = true
			KEY_4:
				current_star_type = StarType.BLACK_HOLE
				ghost_star = true

	if event is InputEventMouseButton:
		# Check if mouse is over any UI element
		var is_over_ui = false
		for child in canvas_layer.get_children():
			if child.visible and child is Control:
				if child.get_global_rect().has_point(event.position):
					is_over_ui = true
					break
		
		if event.pressed:
			match event.button_index:
				MOUSE_BUTTON_LEFT:
					if not is_over_ui:
						handle_left_click()
				MOUSE_BUTTON_RIGHT:
					if not is_over_ui:
						if event.double_click:
							handle_double_right_click()
						else:
							handle_right_click()
				MOUSE_BUTTON_WHEEL_UP:
					camera.zoom *= 1.1
				MOUSE_BUTTON_WHEEL_DOWN:
					camera.zoom *= 0.9

	elif event is InputEventMouseMotion:
		if event.button_mask == MOUSE_BUTTON_MASK_MIDDLE:
			camera.position -= event.relative / camera.zoom
		queue_redraw()  # Redraw for ghost updates
		
		# Close panel when clicking outside
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_LEFT:
			var panel_rect = Rect2(value_panel.position, value_panel.custom_minimum_size)
			if not panel_rect.has_point(event.position) and value_panel.visible:
				value_panel.visible = false
				selected_star_index = -1


func handle_double_right_click():
	var click_pos = get_global_mouse_position()
	var clicked_star = find_clicked_star(click_pos)

	if clicked_star != -1:
		var star = stars[clicked_star]
		if star.type in [StarType.WORMHOLE, StarType.BLACK_HOLE]:
			selected_star_index = clicked_star
			show_value_panel(click_pos)

func show_value_panel(pos: Vector2):
	if selected_star_index != -1:
		var star = stars[selected_star_index]
		min_value_input.value = star.get("min_value", 1)  # Changed default to 1
		max_value_input.value = star.get("max_value", 1)  # Changed default to 1
		
		# Get the camera and viewport
		var camera = get_viewport().get_camera_2d()
		var viewport_size = get_viewport().get_visible_rect().size
		
		# Calculate the screen position, taking zoom into account
		var screen_pos = (pos - camera.position) * camera.zoom + viewport_size / 2
		
		# Set the panel position with a small offset
		value_panel.position = screen_pos + Vector2(100, 100)  # Small offset to avoid covering the cursor
		
		# Ensure the panel stays within the screen bounds
		value_panel.position = value_panel.position.clamp(Vector2(0, 0), viewport_size - value_panel.size)
		
		# Make the panel visible
		value_panel.visible = true

func update_star_values():
	if selected_star_index != -1:
		var star = stars[selected_star_index]
		star.min_value = min_value_input.value
		star.max_value = max_value_input.value
		star.requirement = star.max_value  # Update displayed value to show maximum
		queue_redraw()

func find_clicked_star(click_pos: Vector2) -> int:
	# Use the consistent grid position calculation
	var grid_pos = get_grid_position(click_pos)
	
	# Check if there's a star at these grid coordinates
	for i in range(stars.size()):
		var star = stars[i]
		if star.x == grid_pos.x and star.y == grid_pos.y:
			return i
	return -1

func handle_right_click():
	var click_pos = get_global_mouse_position()
	var clicked_star = find_clicked_star(click_pos)
	
	if line_start == null:
		if clicked_star != -1:
			line_start = stars[clicked_star]
			ghost_line = {"start_x": line_start.x, "start_y": line_start.y}
	else:
		if clicked_star != -1:
			var end_star = stars[clicked_star]
			if end_star != line_start:
				# First check if line already exists (exact match)
				var line_exists = -1
				for i in range(lines.size()):
					var line = lines[i]
					if (stars[line.from] == line_start and stars[line.to] == end_star) or \
					   (stars[line.from] == end_star and stars[line.to] == line_start):
						line_exists = i
						break
				
				if line_exists != -1:
					# Delete existing line
					record_action("remove_line", {
						"index": line_exists,
						"line": lines[line_exists].duplicate()
					})
					lines.remove_at(line_exists)
				else:
					# Check for overlapping lines (but not exact matches)
					var start_grid = Vector2(line_start.x, line_start.y)
					var end_grid = Vector2(end_star.x, end_star.y)
					var overlapping = false
					
					for line in lines:
						var existing_start = Vector2(stars[line.from].x, stars[line.from].y)
						var existing_end = Vector2(stars[line.to].x, stars[line.to].y)
						
						# Skip exact matches (they're handled above)
						if (existing_start == start_grid and existing_end == end_grid) or \
						   (existing_start == end_grid and existing_end == start_grid):
							continue
						
						if do_lines_overlap(start_grid, end_grid, existing_start, existing_end):
							overlapping = true
							break
					
					if not overlapping:
						# Create new line only if there's no overlap
						var new_line = {
							"from": stars.find(line_start),
							"to": clicked_star
						}
						record_action("add_line", {
							"index": lines.size(),
							"line": new_line.duplicate()
						})
						lines.append(new_line)
		
		line_start = null
		ghost_line = null
	
	queue_redraw()
	update_connection_counter()
	
func get_grid_position(pos: Vector2) -> Vector2:
	# Always shift the position by half a grid size before calculating grid coordinates
	var shifted_pos = pos + Vector2(GRID_SIZE/2, GRID_SIZE/2)
	return Vector2(
		floor(shifted_pos.x / GRID_SIZE),
		floor(shifted_pos.y / GRID_SIZE)
	)
	
func find_star_at_position(x: int, y: int) -> int:
	for i in range(stars.size()):
		if stars[i].x == x and stars[i].y == y:
			return i
	return -1

# UI Functions
func show_save_overlay():
	saving_overlay = true
	# Implementation for save dialog

func show_load_overlay():
	loading_overlay = true
	# Implementation for load dialog

func show_settings_overlay():
	settings_overlay = true
	# Implementation for settings dialog

func toggle_tips():
	tips_overlay = !tips_overlay
	tips_label.visible = tips_overlay

func is_valid_grid_position(pos: Vector2) -> bool:
	return pos.x >= 0 and pos.x <= map_width and pos.y >= 0 and pos.y <= map_height

func setup_value_panel():
	value_panel = Panel.new()
	value_panel.visible = false
	value_panel.custom_minimum_size = Vector2(150, 80)
	
	var panel_theme = Theme.new()
	var panel_style = StyleBoxFlat.new()
	panel_style.bg_color = Color(0.15, 0.15, 0.15, 0.95)
	panel_style.border_color = Color.WHITE
	panel_style.border_width_left = 1
	panel_style.border_width_right = 1
	panel_style.border_width_top = 1
	panel_style.border_width_bottom = 1
	panel_theme.set_stylebox("panel", "Panel", panel_style)
	value_panel.theme = panel_theme
	
	var vbox = VBoxContainer.new()
	vbox.custom_minimum_size = Vector2(140, 70)
	vbox.position = Vector2(5, 5)
	
	# Min value row
	var min_hbox = HBoxContainer.new()
	var min_label = Label.new()
	min_label.text = "Min:"
	min_value_input = SpinBox.new()
	min_value_input.min_value = 1
	min_value_input.max_value = 9
	min_value_input.value = 2
	min_value_input.custom_minimum_size = Vector2(60, 0)
	min_value_input.value_changed.connect(func(new_value): 
		# Ensure min value doesn't exceed max value
		if new_value > max_value_input.value:
			min_value_input.value = max_value_input.value
		update_star_values()
	)
	min_hbox.add_child(min_label)
	min_hbox.add_child(min_value_input)
	
	# Max value row
	var max_hbox = HBoxContainer.new()
	var max_label = Label.new()
	max_label.text = "Max:"
	max_value_input = SpinBox.new()
	max_value_input.min_value = 1
	max_value_input.max_value = 9
	max_value_input.value = 2
	max_value_input.custom_minimum_size = Vector2(60, 0)
	max_value_input.value_changed.connect(func(new_value):
		# Ensure max value doesn't go below min value
		if new_value < min_value_input.value:
			max_value_input.value = min_value_input.value
		update_star_values()
	)
	max_hbox.add_child(max_label)
	max_hbox.add_child(max_value_input)
	
	vbox.add_child(min_hbox)
	vbox.add_child(max_hbox)
	value_panel.add_child(vbox)
	canvas_layer.add_child(value_panel)

func handle_left_click():
	var click_pos = get_global_mouse_position()
	var clicked_star = find_clicked_star(click_pos)
	var grid_pos = get_grid_position(click_pos)
	
	# Check if mouse is over any UI element
	for child in canvas_layer.get_children():
		if child.visible and child is Control:
			if child.get_global_rect().has_point(click_pos):
				return
	
	if not is_valid_grid_position(grid_pos):
		return
		
	if clicked_star == -1:
		# Place new star
		var new_star = {
			"x": grid_pos.x,
			"y": grid_pos.y,
			"type": current_star_type
		}

		# Add min and max values for wormholes and black holes
		if current_star_type in [StarType.WORMHOLE, StarType.BLACK_HOLE]:
			new_star["min_value"] = 2
			new_star["max_value"] = 2
			new_star["requirement"] = 2

		# Record the action before adding the star
		record_action("add_star", {
			"index": stars.size(),
			"star": new_star.duplicate()
		})
		stars.append(new_star)
	else:
		if stars[clicked_star].type == current_star_type:
			# Record the remove action with connected lines
			var connected_lines = get_connected_lines(clicked_star)
			record_action("remove_star", {
				"index": clicked_star,
				"star": stars[clicked_star].duplicate(),
				"connected_lines": connected_lines
			})
			# Remove star and all connected lines
			remove_star_and_lines(clicked_star)
		else:
			# Record the change action
			record_action("change_star", {
				"index": clicked_star,
				"old_state": stars[clicked_star].duplicate(),
				"new_state": {
					"x": stars[clicked_star].x,
					"y": stars[clicked_star].y,
					"type": current_star_type,
					"min_value": 2,
					"max_value": 2,
					"requirement": 2
				}
			})
			# Change star type
			stars[clicked_star].type = current_star_type
			if current_star_type in [StarType.WORMHOLE, StarType.BLACK_HOLE]:
				stars[clicked_star]["min_value"] = 2
				stars[clicked_star]["max_value"] = 2
				stars[clicked_star]["requirement"] = 2
	
	queue_redraw()
	update_connection_counter()
func do_lines_overlap(start1: Vector2, end1: Vector2, start2: Vector2, end2: Vector2) -> bool:
	# Convert points to world coordinates
	start1 *= GRID_SIZE
	end1 *= GRID_SIZE
	start2 *= GRID_SIZE
	end2 *= GRID_SIZE
	
	# Calculate directions and lengths
	var dir1 = (end1 - start1).normalized()
	var dir2 = (end2 - start2).normalized()
	
	# Check if lines are parallel (same or opposite direction)
	if abs(dir1.dot(dir2)) > 0.999999:
		# Get the vector between start points
		var v = start2 - start1
		
		# Project v onto the line direction
		var proj = v.dot(dir1)
		
		# Calculate the perpendicular distance between the lines
		var perp_dist = (v - proj * dir1).length()
		
		# If lines aren't practically coincident, they don't overlap (
		if perp_dist > 0.000001:
			return false
		
		# Calculate the parameters for both lines' endpoints
		var t1_start = 0
		var t1_end = (end1 - start1).length()
		var t2_start = proj
		var t2_end = proj + (end2 - start2).length() * dir2.dot(dir1)

# Ensure t2_start <= t2_end
		if t2_start > t2_end:
			var temp = t2_start
			t2_start = t2_end
			t2_end = temp

# Check for overlap in the parameter space
# Modified condition to exclude the case where lines just touch at the endpoints
		return not (t2_end <= t1_start or t2_start >= t1_end)
	
	return false
