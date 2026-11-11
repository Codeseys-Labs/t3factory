import { StackActions, useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { NavigationRow } from "../../components/ui/NavigationRow";

/** Opens Tasks from the top of the thread list. */
export function TasksEntryRow() {
  const navigation = useNavigation();
  return (
    <View className="px-4 pb-2 pt-1">
      <NavigationRow
        title="Tasks"
        className="rounded-xl"
        leading={<SymbolView name="square.grid.2x2" size={20} tintColorClassName="accent-icon" />}
        onPress={() => navigation.dispatch(StackActions.push("Tasks"))}
      />
    </View>
  );
}
